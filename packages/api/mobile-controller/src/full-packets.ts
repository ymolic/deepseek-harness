/** Bounded, acknowledged fragmentation inside an authenticated encrypted connection. */
import { randomBytes } from 'node:crypto'
import { isRecord } from './protocol.ts'

const CHUNK = 12000
const MAX_PACKET = 16 * 1024 * 1024

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
 * Serialize large application frames without relaxing the encrypted frame limit.
 * One configured fragment window spans concurrent packets; acknowledgements bypass the data queue.
 */
export class FullPackets {
  private outgoing = Promise.resolve()
  private readonly window: Promise<void>[] = []
  private readonly waiting = new Map<string, {
    resolve(): void
    reject(error: Error): void
    timer: ReturnType<typeof setTimeout>
  }>()
  private incoming: { id: string; index: number; parts: Buffer[]; size: number } | undefined
  private closed = false

  /**
   * @param transmit - ordered encrypted-frame sender.
   * @param receive - complete application-frame consumer.
   * @param windowSize - validated maximum unacknowledged fragments, from deployment configuration.
   */
  constructor(private readonly transmit: (value: object) => Promise<void>,
    private readonly receive: (value: unknown) => void, private readonly windowSize: number) {}

  /** @param value - one decoded encrypted frame. @returns after acknowledgement or packet delivery. */
  async accept(value: unknown): Promise<void> {
    if (this.closed) return
    if (!isRecord(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.id)
      || !Number.isSafeInteger(value.index) || typeof value.index !== 'number' || value.index < 0) throw new Error('invalid fragment')
    if (value.type === 'ack' && Object.keys(value).length === 3) {
      const key = `${value.id}:${value.index}`
      const pending = this.waiting.get(key)
      if (pending) {
        clearTimeout(pending.timer)
        pending.resolve()
        this.waiting.delete(key)
      }
      return
    }
    if (value.type !== 'part' || Object.keys(value).length !== 5 || typeof value.end !== 'boolean'
      || typeof value.data !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value.data) || value.data.length > CHUNK * 4 / 3) throw new Error('invalid fragment')
    if (!this.incoming) {
      if (value.index !== 0) throw new Error('fragment gap')
      this.incoming = { id: value.id, index: 0, parts: [], size: 0 }
    }
    const current = this.incoming
    if (current.id !== value.id || current.index !== value.index) throw new Error('fragment gap')
    const bytes = Buffer.from(value.data, 'base64url')
    current.size += bytes.length
    if (current.size > MAX_PACKET) throw new Error('packet limit')
    current.parts.push(bytes)
    current.index++
    await this.transmit({ type: 'ack', id: value.id, index: value.index })
    if (value.end) {
      this.incoming = undefined
      this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(current.parts))))
    }
  }

  /** @param value - application frame. @returns after every fragment has been acknowledged. */
  send(value: object): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > MAX_PACKET) return Promise.reject(new Error('packet limit'))
    const outstanding: Promise<void>[] = []
    const writing = this.outgoing.then(async () => {
      const id = randomBytes(16).toString('base64url')
      for (let offset = 0, index = 0; offset < bytes.length; offset += CHUNK, index++) {
        if (this.window.length >= this.windowSize) await this.window.shift()
        if (this.closed) throw new Error('connection closed')
        const key = `${id}:${index}`
        const acknowledged = new Promise<void>((resolve, reject) => {
          this.waiting.set(key, { resolve, reject, timer: setTimeout(() => {
            this.waiting.delete(key)
            reject(new Error('fragment acknowledgement timeout'))
          }, 30000) })
        })
        void acknowledged.catch(() => undefined)
        outstanding.push(acknowledged)
        this.window.push(acknowledged)
        await this.transmit({ type: 'part', id, index, end: offset + CHUNK >= bytes.length,
          data: bytes.subarray(offset, offset + CHUNK).toString('base64url') })
      }
    }).catch((error: unknown) => { this.close(); throw error })
    this.outgoing = writing.catch(() => undefined)
    return writing.then(async () => { await Promise.all(outstanding) })
      .catch((error: unknown) => { this.close(); throw error })
  }

  /** Reject pending sends and erase incomplete plaintext on transport loss. */
  close(): void {
    this.closed = true
    this.incoming = undefined
    this.window.length = 0
    for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(new Error('connection closed')) }
    this.waiting.clear()
  }
}
