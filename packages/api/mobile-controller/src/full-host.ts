/** Durable instance consent and reconnect supervision for the full Web client. */
import { randomBytes } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebSocket } from 'ws'
import { z } from 'zod'
import { MobileCipher, isRecord, MOBILE_WIRE } from './protocol.ts'
import { closeDevice, connectDevice, createRoom, revokeRoom } from './relay-client.ts'
import { FullPackets, fullDownloadWindow } from './full-packets.ts'
import { FullCarrier } from './full-carrier.ts'
import type { MobileDesktopState, MobileStartResult } from './types.ts'

const KEY = credentialKey('mobile-controller', 'trusted-device')
const token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const savedSchema = z.object({
  version: z.literal(2), origin: z.string(), secret: token, revoked: z.boolean(),
  room: z.object({ roomId: z.string().regex(/^[A-Za-z0-9_-]{24}$/), deviceToken: token, pairingTicket: token,
    expiresAt: z.number().int(), authorizationExpiresAt: z.number().int() }).strict(),
}).strict()
type Saved = z.infer<typeof savedSchema>

/** Deployment inputs shared with the owning MobileController. */
export interface FullHostConfig {
  readonly enabled: boolean
  readonly relayOrigin: string
  readonly credential: string
  readonly requestTimeoutMs: number
  readonly fullFragmentWindow: number
}

/** One durable device, with fresh authenticated traffic keys after every reconnect. */
export class FullMobileHost {
  private saved: Saved | undefined
  private state: MobileDesktopState
  private socket: WebSocket | undefined
  private root: MobileCipher | undefined
  private traffic: MobileCipher | undefined
  private packets: FullPackets | undefined
  private carrier: FullCarrier | undefined
  private nonce: string | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private attempts = 0
  private disposed = false
  private startAbort: AbortController | undefined
  private restoreFailed = false
  private readonly draining = new Set<Promise<void>>()
  private operation = Promise.resolve()
  private readonly ready: Promise<void>
  private used = false

  /** @param ctx - application service owner. @param config - trusted relay configuration. */
  constructor(private readonly ctx: Context, private readonly config: FullHostConfig) {
    this.state = { phase: config.enabled ? 'stopped' : 'disabled', sessionId: null, title: '', expiresAt: null,
      ticketExpiresAt: null, relayRevoked: true, scope: 'instance', mobileOnline: false }
    this.ready = this.restore().catch((_error: unknown) => {
      this.used = true
      this.restoreFailed = true
      this.state = { ...this.state, phase: 'failed', relayRevoked: false }
      ctx.logger.warn('Saved phone trust could not be restored; no mobile operations are accepted. Forget the device to clear the local record; relay revocation cannot be confirmed.')
    })
    ctx.effect(() => async () => {
      this.disposed = true
      this.startAbort?.abort()
      clearTimeout(this.retry)
      await this.ready
      await this.operation
      await this.disconnect()
      // Unloading the Host is not device revocation.
    }, 'mobile: persistent device connection')
  }

  /** @returns whether instance consent owns the desktop status surface. */
  active(): boolean { return this.used }

  /** @returns after saved trust has either restored or failed visibly. */
  initialized(): Promise<void> { return this.ready }

  /** @returns non-secret state; pairing material is returned only while awaiting the first scan. */
  status(): MobileDesktopState {
    return this.state
  }

  /**
   * @param preflight - removal of any preceding legacy grant.
   * @returns short-lived enrollment material after the durable trust record commits.
   */
  start(preflight: Promise<boolean> = Promise.resolve(true)): Promise<MobileStartResult> {
    if (this.startAbort) return Promise.reject(new Error('phone pairing already starting'))
    this.used = true
    const abort = new AbortController()
    this.startAbort = abort
    const task = this.exclusive(async () => {
      if (this.disposed || !this.config.enabled) throw new Error('mobile unavailable')
      if (!await preflight) throw new Error('previous revocation unconfirmed')
      abort.signal.throwIfAborted()
      if (this.restoreFailed) throw new Error('saved phone trust requires review')
      await this.forget()
      abort.signal.throwIfAborted()
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credential))
      if (!credential || !/^[A-Za-z0-9_-]{32,256}$/.test(credential.value)) throw new Error('desktop credential unavailable')
      abort.signal.throwIfAborted()
      this.state = { ...this.state, phase: 'starting' }
      const room = await createRoom(this.config.relayOrigin, credential.value,
        AbortSignal.any([abort.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]), true)
      const saved: Saved = { version: 2, origin: this.config.relayOrigin, room,
        secret: randomBytes(32).toString('base64url'), revoked: false }
      try { abort.signal.throwIfAborted(); await this.write(saved) }
      catch (error) {
        await revokeRoom(this.config.relayOrigin, room, this.config.requestTimeoutMs)
        throw error
      }
      this.saved = saved
      abort.signal.throwIfAborted()
      const fragment = new URLSearchParams({ room: room.roomId, ticket: room.pairingTicket, key: saved.secret, mode: 'full' })
      const pairingUrl = `${this.config.relayOrigin}/#${fragment}`
      this.state = { ...this.state, phase: 'waiting', relayRevoked: false, ticketExpiresAt: room.expiresAt, pairingUrl }
      await this.connect()
      return { pairingUrl, state: this.state }
    })
    void task.finally(() => { if (this.startAbort === abort) this.startAbort = undefined }).catch(() => undefined)
    return task
  }

  /** @returns state after local denial and an attempted relay revocation. */
  stop(): Promise<MobileDesktopState> {
    this.startAbort?.abort()
    if (this.saved) this.saved = { ...this.saved, revoked: true }
    this.clearTraffic()
    this.state = { ...this.state, phase: 'stopped', pairingUrl: undefined, mobileOnline: false }
    return this.exclusive(async () => { await this.forget(); return this.state })
  }

  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const task = this.operation.then(async () => { await this.ready; return run() })
    this.operation = task.then(() => undefined, () => {
      this.state = { ...this.state, phase: 'failed' }
    })
    return task
  }

  private async restore(): Promise<void> {
    if (!this.config.enabled) return
    const record = await this.ctx.credentials.readRecord(KEY)
    if (!record) return
    this.used = true
    if (record.kind !== 'grant') throw new Error('invalid saved device')
    const saved = savedSchema.parse(record.payload)
    if (saved.origin !== this.config.relayOrigin) throw new Error('saved relay changed')
    this.saved = saved
    this.state = { ...this.state, phase: saved.revoked ? 'stopped' : 'reconnecting', relayRevoked: false }
    if (!saved.revoked && !this.disposed) {
      await this.connect().catch((_error: unknown) => {
        // Socket close owns reconnection; an offline relay does not corrupt stored trust.
        this.state = { ...this.state, phase: 'reconnecting', mobileOnline: false }
      })
    }
  }

  private write(saved: Saved): Promise<unknown> {
    return this.ctx.credentials.modifyRecord(KEY, () => Promise.resolve({ kind: 'grant', payload: saved }))
  }

  private async forget(): Promise<void> {
    if (this.restoreFailed) {
      await this.disconnect()
      await this.ctx.credentials.deleteRecord(KEY)
      this.restoreFailed = false
      this.state = { ...this.state, phase: 'stopped', relayRevoked: false, pairingUrl: undefined, mobileOnline: false }
      return
    }
    clearTimeout(this.retry)
    const saved = this.saved
    let persistenceError: unknown
    if (saved) {
      // A durable tombstone prevents a crash or offline restart from restoring revoked authority.
      this.saved = { ...saved, revoked: true }
      this.clearTraffic()
      try { await this.write(this.saved) }
      catch (error) { persistenceError = error }
    }
    await this.disconnect()
    this.state = { ...this.state, phase: 'stopped', pairingUrl: undefined, mobileOnline: false }
    if (!saved) return
    const revoked = await revokeRoom(saved.origin, saved.room, this.config.requestTimeoutMs)
    this.state = { ...this.state, relayRevoked: revoked }
    if (!revoked) {
      if (persistenceError !== undefined) throw new AggregateError([persistenceError], 'local and relay revocation unconfirmed')
      throw new Error('relay revocation unconfirmed')
    }
    await this.ctx.credentials.deleteRecord(KEY)
    this.saved = undefined
  }

  private clearTraffic(): void {
    if (this.carrier) {
      const task = this.carrier.settled()
      this.draining.add(task)
      void task.finally(() => this.draining.delete(task)).catch(() => undefined)
    }
    this.packets?.close()
    this.traffic?.dispose()
    this.root?.dispose()
    this.carrier = undefined
    this.packets = undefined
    this.traffic = undefined
    this.root = undefined
    this.nonce = undefined
  }

  private async disconnect(): Promise<void> {
    this.clearTraffic()
    const socket = this.socket
    this.socket = undefined
    await closeDevice(socket)
    await Promise.all(this.draining)
  }

  private async connect(): Promise<void> {
    const saved = this.saved
    if (!saved || saved.revoked || this.disposed) return
    await this.disconnect()
    if (!this.current(saved)) return
    const socket = connectDevice(saved.origin, saved.room, this.config.requestTimeoutMs)
    this.socket = socket
    let denied = false
    socket.on('unexpected-response', (_request, response) => {
      denied = response.statusCode === 401 || response.statusCode === 403
      response.resume()
      socket.terminate()
    })
    let received = Promise.resolve()
    let fragmentWindow = fullDownloadWindow(undefined, this.config.fullFragmentWindow)
    socket.on('message', (bytes, binary) => {
      received = received.then(async () => {
        if (this.socket !== socket || this.disposed || this.saved?.revoked) return
        const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
        if (binary || data.length > MOBILE_WIRE.maxWireBytes) throw new Error('invalid frame')
        const value: unknown = JSON.parse(data.toString('utf8'))
        if (isRecord(value) && value.type === 'status') {
          if (value.protocol !== 2 || value.mode !== 'full-client-e2ee') throw new Error('relay upgrade required')
          fragmentWindow = fullDownloadWindow(value.fullFragmentWindow, this.config.fullFragmentWindow)
          this.state = { ...this.state, phase: value.paired === true ? 'paired' : 'waiting', mobileOnline: value.mobileOnline === true,
            ...(value.paired === true ? { pairingUrl: undefined, ticketExpiresAt: null } : {}) }
          if (!value.mobileOnline) { this.clearTraffic(); return }
          if (!this.nonce) {
            this.clearTraffic()
            this.nonce = randomBytes(16).toString('base64url')
            this.root = new MobileCipher(Buffer.from(saved.secret, 'base64url'), saved.room.roomId)
            await this.transmit(socket, this.root, { type: 'challenge', nonce: this.nonce, protocol: 2 })
          }
          return
        }
        if (!this.traffic) {
          const auth = this.root?.open(value)
          if (!isRecord(auth) || auth.type !== 'authenticate' || Object.keys(auth).length !== 3 || auth.nonce !== this.nonce
            || typeof auth.clientNonce !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(auth.clientNonce)) throw new Error('authentication failed')
          const traffic = new MobileCipher(Buffer.from(saved.secret, 'base64url'), `${saved.room.roomId}:${this.nonce}:${auth.clientNonce}`)
          this.traffic = traffic
          const packets = new FullPackets(frame => this.transmit(socket, traffic, frame),
            (frame) => { carrier.accept(frame) }, fragmentWindow)
          const carrier = new FullCarrier(this.ctx, frame => packets.send(frame).catch((error: unknown) => {
            if (this.socket === socket) socket.close(1011)
            throw error
          }))
          this.packets = packets
          this.carrier = carrier
          this.attempts = 0
          await this.transmit(socket, traffic, { type: 'ready', protocol: 2 })
          return
        }
        const plain = this.traffic.open(value)
        if (plain !== undefined) await this.packets?.accept(plain)
      }).catch((_error: unknown) => {
        // Authentication or framing failure invalidates this connection, not durable device trust.
        if (this.socket === socket) socket.close(1008)
      })
    })
    socket.on('error', (_error: Error) => {
      if (this.socket === socket) this.state = { ...this.state, phase: 'reconnecting', mobileOnline: false }
    })
    socket.on('close', (code) => {
      if (this.socket !== socket) return
      this.clearTraffic()
      this.socket = undefined
      if (this.disposed || this.saved?.revoked) return
      this.state = { ...this.state, phase: denied || code === 4001 ? 'failed' : 'reconnecting', mobileOnline: false }
      if (denied || code === 4000 || code === 4001) return
      const delay = Math.min(30000, 1000 * 2 ** Math.min(this.attempts++, 5))
      this.retry = setTimeout(() => {
        void this.connect().catch((_error: unknown) => {
          if (!this.disposed && !this.saved?.revoked) this.state = { ...this.state, phase: 'reconnecting', mobileOnline: false }
        })
      }, delay)
    })
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', () =>{  reject(new Error('relay connection unavailable')) })
      socket.once('close', () =>{  reject(new Error('relay connection closed')) })
    })
  }

  private current(saved: Saved): boolean {
    return !this.disposed && this.saved === saved && !saved.revoked
  }

  private transmit(socket: WebSocket, cipher: MobileCipher, value: object): Promise<void> {
    if (this.socket !== socket || socket.readyState !== WebSocket.OPEN || this.disposed || this.saved?.revoked) return Promise.reject(new Error('connection closed'))
    const text = JSON.stringify(cipher.seal(value))
    if (socket.bufferedAmount + Buffer.byteLength(text) > 256 * 1024) return Promise.reject(new Error('transport capacity'))
    return new Promise((resolve, reject) => { socket.send(text, (error) => { if (error) reject(new Error('transport unavailable')); else resolve() }) })
  }
}
