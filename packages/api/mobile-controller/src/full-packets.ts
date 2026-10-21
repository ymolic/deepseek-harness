/** Bounded, acknowledged fragmentation inside an authenticated encrypted connection. */
import { randomBytes } from 'node:crypto'
import { isRecord } from './protocol.ts'
import { packetBytes, readPacket, partBytes, readPart } from './full-binary.ts'

const CHUNK = 12000
const MAX_PACKET = 16 * 1024 * 1024
const MAX_ACTIVE_PACKETS = 8
const MAX_INTERACTIVE_PACKET = 32 * 1024
const REASSEMBLY_TIMEOUT_MS = 30000
const SCHEDULE = ['control', 'realtime', 'control', 'bulk'] as const

/** Latency class used by negotiated packet multiplexing. */
export type FullPacketLane = 'control' | 'realtime' | 'bulk'

interface OutgoingPacket {
  readonly operation: string | undefined
  readonly predecessor: OutgoingPacket | undefined
  completed: boolean
  readonly id: string
  readonly bytes: Buffer
  readonly lane: FullPacketLane
  readonly outstanding: Promise<void>[]
  readonly resolveWritten: () => void
  readonly rejectWritten: (error: Error) => void
  offset: number
  index: number
}

interface IncomingPacket {
  readonly id: string
  readonly parts: Buffer[]
  index: number
  size: number
  timer: ReturnType<typeof setTimeout> | undefined
}

/** Local write failures reject both phases; later ACK failures reject only acknowledgement. */
export interface FullPacketWrite {
  /** Resolves after every fragment passes the shared window and the local sender. */
  readonly written: Promise<void>
  /** Resolves after the peer acknowledges every fragment; transmit failures and ACK timeouts close the transport. */
  readonly acknowledged: Promise<void>
}

/**
 * Resolve the download window advertised by the relay, retaining legacy admission.
 * @param advertised - optional status field received from the relay.
 * @param configured - validated deployment maximum.
 * @returns the smaller supported window; older relays support eight fragments.
 * @throws when an advertised limit is not an integer from 1 through 32.
 */
export function fullDownloadWindow(advertised: unknown, configured: number): number {
  if (advertised === undefined) return Math.min(8, configured)
  if (typeof advertised !== 'number' || !Number.isSafeInteger(advertised) || advertised < 1 || advertised > 32) {
    throw new Error('invalid relay fragment window')
  }
  return Math.min(advertised, configured)
}

/**
 * @param advertised - optional relay feature list for the connected phone page.
 * @returns whether both relay and phone page support interleaved packet reassembly.
 * @throws when a present feature list is malformed.
 */
export function packetMuxSupport(advertised: unknown): boolean {
  if (advertised === undefined) return false
  if (!Array.isArray(advertised) || advertised.length < 1 || advertised.length > 8
    || !advertised.every(item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(item))
    || new Set(advertised).size !== advertised.length) throw new Error('invalid relay features')
  return advertised.includes('packet-mux-v1')
}

/**
 * Serialize large application frames without relaxing the encrypted frame limit.
 * One configured fragment window spans concurrent packets; acknowledgements bypass the data queue.
 */
export class FullPackets {
  private readonly waiting = new Map<string, {
    resolve(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
    lane: FullPacketLane
  }>()
  private readonly legacyQueue: OutgoingPacket[] = []
  private readonly queues: Record<FullPacketLane, OutgoingPacket[]> = { control: [], realtime: [], bulk: [] }
  private readonly incomingMux = new Map<string, IncomingPacket>()
  private readonly operationTails = new Map<string, OutgoingPacket>()
  private incoming: IncomingPacket | undefined
  private incomingBytes = 0
  private outgoingBytes = 0
  private outgoingPackets = 0
  private scheduleIndex = 0
  private pumping = false
  private capacity: { promise: Promise<void>; resolve(): void } | undefined
  private closed = false

  /**
   * @param transmit - ordered encrypted-frame sender.
   * @param receive - complete application-frame consumer.
   * @param windowSize - validated maximum unacknowledged fragments, from deployment configuration.
   * @param binary - negotiated raw encoding; omitted or false retains legacy JSON.
   * @param multiplex - whether fragments from latency classes may interleave.
   * @param onFailure - closes the owning connection after an asynchronous packet failure.
   */
  constructor(private readonly transmit: (value: object) => Promise<void>,
    private readonly receive: (value: unknown) => void, private readonly windowSize: number,
    private readonly binary = false, private readonly multiplex = false,
    private readonly onFailure?: (error: Error) => void) {}

  /** @param value - one decoded encrypted frame. @returns after acknowledgement or packet delivery. */
  async accept(value: unknown): Promise<void> {
    if (this.isClosed()) return
    if (this.binary && value instanceof Uint8Array) value = readPart(value)
    if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.id)
      || !Number.isSafeInteger(value.index) || typeof value.index !== 'number' || value.index < 0) throw new Error('invalid fragment')
    if (value.type === 'ack' && Object.keys(value).length === 3) {
      const key = `${value.id}:${value.index}`
      const pending = this.waiting.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        this.waiting.delete(key)
        pending.resolve()
        this.notifyCapacity()
      }
      return
    }
    if (value.type !== 'part' || Object.keys(value).length !== 5 || typeof value.end !== 'boolean'
      || (this.binary ? !(value.data instanceof Uint8Array)
        : typeof value.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value.data) || value.data.length > CHUNK * 4 / 3)) throw new Error('invalid fragment')
    const bytes = value.data instanceof Uint8Array ? Buffer.from(value.data) : Buffer.from(String(value.data), 'base64url')
    if (this.multiplex) {
      await this.acceptMultiplexed(value.id, value.index, value.end, bytes)
      return
    }
    if (!this.incoming) {
      if (value.index !== 0) throw new Error('fragment gap')
      this.incoming = { id: value.id, index: 0, parts: [], size: 0, timer: undefined }
    }
    const current = this.incoming
    if (current.id !== value.id || current.index !== value.index) throw new Error('fragment gap')
    current.size += bytes.length
    if (current.size > MAX_PACKET) throw new Error('packet limit')
    current.parts.push(bytes)
    current.index++
    await this.transmit({ type: 'ack', id: value.id, index: value.index })
    if (this.closed) return
    if (value.end) {
      this.incoming = undefined
      const packet = Buffer.concat(current.parts)
      this.receive(this.binary ? readPacket(packet) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packet)))
    }
  }

  /**
   * @param value - application frame.
   * @param lane - requested latency class; oversized interactive packets use bulk capacity.
   * @returns after every fragment has been acknowledged.
   */
  send(value: object, lane: FullPacketLane = 'control'): Promise<void> {
    return this.write(value, lane).acknowledged
  }

  /**
   * Queue one ordered packet; the shared fragment window still bounds unacknowledged bytes.
   * @param value - application frame; callers await `written` before queuing their next packet.
   * @param lane - requested latency class; ignored until packet multiplexing is negotiated.
   * @returns local writing and peer acknowledgement, both of which the caller must observe.
   */
  write(value: object, lane: FullPacketLane = 'control'): FullPacketWrite {
    let bytes: Buffer
    try {
      bytes = this.binary ? packetBytes(value) : Buffer.from(JSON.stringify(value))
      if (bytes.length > MAX_PACKET) throw new Error('packet limit')
    } catch (error) {
      const failed = Promise.reject<void>(error instanceof Error ? error : new Error('packet encoding failed', { cause: error }))
      return { written: failed, acknowledged: failed }
    }
    if (this.closed) {
      const failed = Promise.reject<void>(new Error('connection closed'))
      return { written: failed, acknowledged: failed }
    }
    const selected = this.multiplex && lane !== 'bulk' && bytes.length > MAX_INTERACTIVE_PACKET ? 'bulk' : lane
    let resolveWritten: () => void = () => {}
    let rejectWritten: (error: Error) => void = () => {}
    const written = new Promise<void>((resolve, reject) => { resolveWritten = resolve; rejectWritten = reject })
    const outstanding: Promise<void>[] = []
    const operation = isRecord(value) && typeof value.id === 'string' ? value.id : undefined
    const predecessor = operation === undefined ? undefined : this.operationTails.get(operation)
    const packet: OutgoingPacket = { operation, predecessor, completed: false,
      id: randomBytes(16).toString('base64url'), bytes, lane: selected, outstanding,
      resolveWritten, rejectWritten, offset: 0, index: 0 }
    if (operation !== undefined) this.operationTails.set(operation, packet)
    if (this.multiplex) this.queues[selected].push(packet)
    else this.legacyQueue.push(packet)
    const acknowledged = written.then(async () => { await Promise.all(outstanding) })
      .catch((error: unknown) => {
        const failure = error instanceof Error ? error : new Error('packet acknowledgement failed', { cause: error })
        this.abort(failure, true)
        throw failure
      })
    void acknowledged.catch(() => undefined)
    this.notifyCapacity()
    this.startPump()
    return { written, acknowledged }
  }

  /** Reject pending sends and erase incomplete plaintext on transport loss. */
  close(): void {
    this.abort(new Error('connection closed'), false)
  }

  private async acceptMultiplexed(id: string, index: number, end: boolean, bytes: Buffer): Promise<void> {
    let current = this.incomingMux.get(id)
    if (!current) {
      if (index !== 0) throw new Error('fragment gap')
      if (this.incomingMux.size >= MAX_ACTIVE_PACKETS) throw new Error('packet reassembly limit')
      current = { id, index: 0, parts: [], size: 0, timer: undefined }
      this.incomingMux.set(id, current)
    }
    if (current.index !== index) throw new Error('fragment gap')
    if (current.size + bytes.length > MAX_PACKET || this.incomingBytes + bytes.length > MAX_PACKET) throw new Error('packet limit')
    current.size += bytes.length
    this.incomingBytes += bytes.length
    current.parts.push(bytes)
    current.index++
    clearTimeout(current.timer)
    current.timer = setTimeout(() => {
      if (this.incomingMux.get(id) === current) this.abort(new Error('fragment reassembly timeout'), true)
    }, REASSEMBLY_TIMEOUT_MS)
    await this.transmit({ type: 'ack', id, index })
    if (this.closed) return
    if (!end) return
    clearTimeout(current.timer)
    this.incomingMux.delete(id)
    this.incomingBytes -= current.size
    const packet = Buffer.concat(current.parts)
    this.receive(this.binary ? readPacket(packet) : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(packet)))
  }

  private startPump(): void {
    if (this.pumping || this.closed) return
    this.pumping = true
    void this.pump().catch((error: unknown) => {
      this.abort(error instanceof Error ? error : new Error('packet transmit failed', { cause: error }), true)
    })
  }

  private async pump(): Promise<void> {
    while (!this.closed) {
      const packet = this.nextPacket()
      if (!packet) {
        if (!this.hasQueued()) { this.pumping = false; return }
        await this.waitForCapacity()
        continue
      }
      const key = `${packet.id}:${packet.index}`
      if (this.multiplex && packet.index === 0) {
        this.outgoingBytes += packet.bytes.length
        this.outgoingPackets++
      }
      const acknowledged = new Promise<void>((resolve, reject) => {
        this.waiting.set(key, { resolve, reject, lane: packet.lane, timer: setTimeout(() => {
          const pending = this.waiting.get(key)
          if (pending) {
            this.waiting.delete(key)
            const error = new Error('fragment acknowledgement timeout')
            pending.reject(error)
            this.abort(error, true)
          }
        }, 30000) })
      })
      void acknowledged.catch(() => undefined)
      packet.outstanding.push(acknowledged)
      const payload = packet.bytes.subarray(packet.offset, packet.offset + CHUNK)
      const end = packet.offset + CHUNK >= packet.bytes.length
      await this.transmit(this.binary ? partBytes(packet.id, packet.index, end, payload)
        : { type: 'part', id: packet.id, index: packet.index, end, data: payload.toString('base64url') })
      if (this.isClosed()) return
      packet.offset += payload.length
      packet.index++
      if (end) {
        if (this.multiplex) {
          this.outgoingBytes -= packet.bytes.length
          this.outgoingPackets--
        }
        if (this.multiplex) this.queues[packet.lane].splice(this.queues[packet.lane].indexOf(packet), 1)
        else this.legacyQueue.shift()
        packet.completed = true
        if (packet.operation !== undefined && this.operationTails.get(packet.operation) === packet) {
          this.operationTails.delete(packet.operation)
        }
        packet.resolveWritten()
      }
    }
    throw new Error('connection closed')
  }

  private nextPacket(): OutgoingPacket | undefined {
    if (!this.multiplex) {
      const packet = this.legacyQueue[0]
      return packet && this.canSend(packet.lane) ? packet : undefined
    }
    for (let offset = 0; offset < SCHEDULE.length; offset++) {
      const position = (this.scheduleIndex + offset) % SCHEDULE.length
      const lane = SCHEDULE[position]
      if (lane === undefined) continue
      const packet = this.queues[lane].find(value => (!value.predecessor || value.predecessor.completed)
        && (value.index > 0 || this.outgoingPackets < MAX_ACTIVE_PACKETS && this.outgoingBytes + value.bytes.length <= MAX_PACKET))
      if (packet && this.canSend(lane)) {
        this.scheduleIndex = (position + 1) % SCHEDULE.length
        return packet
      }
    }
    return undefined
  }

  private canSend(lane: FullPacketLane): boolean {
    if (this.waiting.size >= this.windowSize) return false
    if (!this.multiplex || this.windowSize === 1) return true
    let count = 0
    let nonControl = 0
    for (const pending of this.waiting.values()) {
      if (pending.lane === lane) count++
      if (pending.lane !== 'control') nonControl++
    }
    if (lane !== 'control' && nonControl >= this.windowSize - 1) return false
    if (lane === 'bulk') return count < Math.max(1, this.windowSize - (this.windowSize >= 8 ? 2 : 1))
    if (lane === 'realtime') return count < this.windowSize - 1
    return true
  }

  private hasQueued(): boolean {
    return this.multiplex ? this.queues.control.length + this.queues.realtime.length + this.queues.bulk.length > 0
      : this.legacyQueue.length > 0
  }

  private waitForCapacity(): Promise<void> {
    if (!this.capacity) {
      let resolve: () => void = () => {}
      const promise = new Promise<void>((done) => { resolve = done })
      this.capacity = { promise, resolve }
    }
    return this.capacity.promise
  }

  private notifyCapacity(): void {
    const capacity = this.capacity
    this.capacity = undefined
    capacity?.resolve()
  }

  private isClosed(): boolean {
    return this.closed
  }

  private abort(error: Error, report: boolean): void {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.incoming?.timer)
    this.incoming = undefined
    for (const packet of this.incomingMux.values()) clearTimeout(packet.timer)
    this.incomingMux.clear()
    this.incomingBytes = 0
    this.outgoingBytes = 0
    this.outgoingPackets = 0
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.waiting.clear()
    this.operationTails.clear()
    for (const packet of this.legacyQueue) packet.rejectWritten(error)
    this.legacyQueue.length = 0
    for (const lane of ['control', 'realtime', 'bulk'] as const) {
      for (const packet of this.queues[lane]) packet.rejectWritten(error)
      this.queues[lane].length = 0
    }
    this.notifyCapacity()
    if (report) {
      try { this.onFailure?.(error) }
      catch (_reportError) { /* The transport is already closed; its owner cannot recover it here. */ }
    }
  }
}
