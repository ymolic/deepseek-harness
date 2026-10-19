/** AES-GCM text channel. A QR secret is never sent to the relay. */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import type { MobileRequest, MobileChannelId, MobileRequestId } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { FULL_BINARY, binaryHeader, binaryAAD } from './full-binary.ts'

/** Limits shared by the published mobile wire protocol. */
export const MOBILE_WIRE = { maxPlainBytes: 32 * 1024, maxWireBytes: 48 * 1024, maxTextBytes: 8000, maxGenerations: 32 } as const

/** Opaque relay envelope; all fields are authenticated by AES-GCM. */
export interface SealedFrame {
  readonly type: 'sealed'
  readonly epoch: string
  readonly seq: number
  readonly iv: string
  readonly data: string
}

/** Parse only records before inspecting untrusted JSON fields.
 * @param value - untrusted JSON value.
 * @returns whether named property access is safe.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

/** Reject extra authority fields as well as unknown methods.
 * @param value - decrypted JSON.
 * @returns a validated command, or undefined for any unsupported request.
 */
export function mobileRequest(value: unknown): MobileRequest | undefined {
  if (!isRecord(value) || typeof value.channel !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.channel)) return
  const channel = value.channel as MobileChannelId
  if ((value.type === 'hello' || value.type === 'sync' || value.type === 'workspace:list' || value.type === 'model:list') && exact(value, ['type', 'channel'])) {
    return { type: value.type, channel }
  }
  if (value.type === 'session:create') {
    if (exact(value, ['type', 'channel'])) return { type: 'session:create', channel }
    if (exact(value, ['type', 'channel', 'workspaceId']) && typeof value.workspaceId === 'string' && value.workspaceId.length > 0 && value.workspaceId.length <= 128) {
      return { type: 'session:create', channel, workspaceId: value.workspaceId }
    }
    return
  }
  if (value.type === 'session:permission') {
    if (exact(value, ['type', 'channel', 'mode']) && (value.mode === 'plan' || value.mode === 'build' || value.mode === 'auto' || value.mode === 'yolo')) {
      return { type: 'session:permission', channel, mode: value.mode }
    }
    return
  }
  if (value.type === 'session:select_model') {
    if (exact(value, ['type', 'channel', 'provider', 'model']) && typeof value.provider === 'string' && value.provider.length > 0 && value.provider.length <= 128
      && typeof value.model === 'string' && value.model.length > 0 && value.model.length <= 128) {
      return { type: 'session:select_model', channel, provider: value.provider, model: value.model }
    }
    return
  }
  if (value.type === 'workspace:switch') {
    if (typeof value.workspaceId !== 'string' || value.workspaceId.length === 0 || value.workspaceId.length > 128) return
    if (exact(value, ['type', 'channel', 'workspaceId'])) return { type: 'workspace:switch', channel, workspaceId: value.workspaceId }
    if (exact(value, ['type', 'channel', 'workspaceId', 'sessionId']) && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 128) {
      return { type: 'workspace:switch', channel, workspaceId: value.workspaceId, sessionId: value.sessionId as SessionId }
    }
    return
  }
  if (value.type === 'session:follow' || value.type === 'session:cancel') {
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128) return
    if (exact(value, ['type', 'channel', 'sessionId'])) return { type: value.type, channel, sessionId: value.sessionId as SessionId }
    return
  }
  if (value.type === 'session:rename') {
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128) return
    if (typeof value.title !== 'string' || value.title.trim().length === 0 || Buffer.byteLength(value.title) > 200) return
    if (exact(value, ['type', 'channel', 'sessionId', 'title'])) {
      return { type: 'session:rename', channel, sessionId: value.sessionId as SessionId, title: value.title.trim() }
    }
    return
  }
  if (value.type === 'session:archive' || value.type === 'session:pin' || value.type === 'session:unpin') {
    if (typeof value.sessionId !== 'string' || value.sessionId.length === 0 || value.sessionId.length > 128) return
    if (exact(value, ['type', 'channel', 'sessionId'])) {
      return { type: value.type, channel, sessionId: value.sessionId as SessionId }
    }
    return
  }
  if (value.type === 'approval:respond') {
    if (typeof value.requestId !== 'string' || value.requestId.length === 0 || value.requestId.length > 128 || typeof value.approved !== 'boolean') return
    if (exact(value, ['type', 'channel', 'requestId', 'approved'])) return { type: 'approval:respond', channel, requestId: value.requestId, approved: value.approved }
    if (exact(value, ['type', 'channel', 'requestId', 'approved', 'rationale']) && typeof value.rationale === 'string' && Buffer.byteLength(value.rationale) <= 1000) {
      return { type: 'approval:respond', channel, requestId: value.requestId, approved: value.approved, rationale: value.rationale }
    }
    return
  }
  if (value.type === 'question:answer') {
    if (typeof value.questionId !== 'string' || value.questionId.length === 0 || value.questionId.length > 128 || !isRecord(value.answers)) return
    if (exact(value, ['type', 'channel', 'questionId', 'answers'])) {
      const answers: Record<string, string> = {}
      for (const [k, v] of Object.entries(value.answers)) {
        if (typeof k !== 'string' || k.length > 128 || typeof v !== 'string' || Buffer.byteLength(v) > 2000) return
        answers[k] = v
      }
      return { type: 'question:answer', channel, questionId: value.questionId, answers }
    }
    return
  }
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value.id)) return
  const id = value.id as MobileRequestId
  if (value.type === 'receipt' && exact(value, ['type', 'channel', 'id'])) return { type: 'receipt', channel, id }
  if (value.type === 'send') {
    if (typeof value.text !== 'string' || value.text.trim().length === 0 || Buffer.byteLength(value.text) > MOBILE_WIRE.maxTextBytes) return
    if (exact(value, ['type', 'channel', 'id', 'text'])) return { type: 'send', channel, id, text: value.text }
    if (exact(value, ['type', 'channel', 'id', 'text', 'sessionId']) && typeof value.sessionId === 'string' && value.sessionId.length > 0 && value.sessionId.length <= 128) {
      return { type: 'send', channel, id, text: value.text, sessionId: value.sessionId as SessionId }
    }
  }
  return
}

/** Each direction uses a different key; bounded epochs reject captured-frame replay. */
export class MobileCipher {
  private readonly sendKey: Buffer
  private readonly receiveKey: Buffer
  private epoch = randomBytes(16).toString('base64url')
  private sequence = 0
  private disposed = false
  private readonly received = new Map<string, number>()

  /**
   * @param secret - 32 random bytes carried only by the QR fragment.
   * @param room - authorization identity used as HKDF salt and authenticated data.
   * @param role - endpoint role; the default is the desktop executor.
   */
  constructor(secret: Uint8Array, private readonly room: string, private readonly role: 'desktop' | 'mobile' = 'desktop') {
    const derive = (direction: string) => Buffer.from(hkdfSync('sha256', secret, room, `dsh-mobile/v1/${direction}`, 32))
    this.sendKey = derive(role)
    this.receiveKey = derive(role === 'desktop' ? 'mobile' : 'desktop')
  }

  /**
   * Encrypt one bounded JSON value.
   * @param value - text-protocol reply or request.
   * @returns the authenticated opaque envelope.
   */
  seal(value: unknown): SealedFrame {
    if (this.disposed) throw new Error('mobile authorization ended')
    const bytes = Buffer.from(JSON.stringify(value))
    if (bytes.length > MOBILE_WIRE.maxPlainBytes || this.sequence >= 100000) throw new Error('mobile frame limit')
    const seq = ++this.sequence
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, iv)
    cipher.setAAD(this.aad(this.role, this.epoch, seq))
    const data = Buffer.concat([cipher.update(bytes), cipher.final(), cipher.getAuthTag()])
    return { type: 'sealed', epoch: this.epoch, seq, iv: iv.toString('base64url'), data: data.toString('base64url') }
  }

  /**
   * Authenticate before publishing JSON or advancing receive sequence.
   * @param value - opaque relay frame.
   * @returns decrypted JSON; undefined for an already processed frame.
   * @throws on malformed, forged, out-of-order, or excessive-generation frames.
   */
  open(value: unknown): unknown {
    if (this.disposed) throw new Error('mobile authorization ended')
    if (!isRecord(value) || !exact(value, ['type', 'epoch', 'seq', 'iv', 'data']) || value.type !== 'sealed'
      || typeof value.epoch !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.epoch)
      || typeof value.seq !== 'number' || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > 100000
      || typeof value.iv !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value.iv)
      || typeof value.data !== 'string' || !/^[A-Za-z0-9_-]{22,44000}$/.test(value.data)) throw new Error('invalid mobile frame')
    const prior = this.received.get(value.epoch) ?? 0
    if (prior === 0 && this.received.size >= MOBILE_WIRE.maxGenerations) throw new Error('mobile generation limit')
    const bytes = Buffer.from(value.data, 'base64url')
    if (bytes.length > MOBILE_WIRE.maxPlainBytes + 16) throw new Error('mobile frame limit')
    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, Buffer.from(value.iv, 'base64url'))
    decipher.setAAD(this.aad(this.role === 'desktop' ? 'mobile' : 'desktop', value.epoch, value.seq))
    decipher.setAuthTag(bytes.subarray(-16))
    const plain = Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()])
    if (value.seq <= prior) return
    if (value.seq !== prior + 1) throw new Error('mobile sequence gap')
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
    this.received.set(value.epoch, value.seq)
    return parsed
  }

  /**
   * Encrypt a negotiated binary fragment or JSON acknowledgement using the traffic context.
   * @param value - raw fragment bytes or control JSON.
   * @returns one bounded binary WebSocket message; shares the legacy send sequence.
   */
  sealBinary(value: object): Buffer {
    if (this.disposed) throw new Error('mobile authorization ended')
    const kind = value instanceof Uint8Array ? 2 : 1
    const plain = value instanceof Uint8Array ? value : Buffer.from(JSON.stringify(value))
    if (plain.length < 1 || plain.length > FULL_BINARY.plain || this.sequence >= 100000) throw new Error('mobile frame limit')
    const header = Buffer.alloc(FULL_BINARY.header)
    header.set([0x44, 0x53, 2, kind]); header.writeUInt32BE(++this.sequence, 4)
    header.set(Buffer.from(this.epoch, 'base64url'), 8); header.set(randomBytes(12), 24)
    const cipher = createCipheriv('aes-256-gcm', this.sendKey, header.subarray(24))
    cipher.setAAD(binaryAAD(this.room, this.role, header))
    return Buffer.concat([header, cipher.update(plain), cipher.final(), cipher.getAuthTag()])
  }

  /**
   * Authenticate every parser-selecting field before delivering plaintext or advancing sequence.
   * @param bytes - negotiated binary WebSocket message.
   * @returns raw fragment or parsed control; undefined for an authenticated duplicate.
   * @throws on malformed, forged, out-of-order or excessive-generation frames.
   */
  openBinary(bytes: Uint8Array): unknown {
    if (this.disposed) throw new Error('mobile authorization ended')
    const header = binaryHeader(bytes)
    const prior = this.received.get(header.epoch) ?? 0
    if (prior === 0 && this.received.size >= MOBILE_WIRE.maxGenerations) throw new Error('mobile generation limit')
    const decipher = createDecipheriv('aes-256-gcm', this.receiveKey, header.iv)
    decipher.setAAD(binaryAAD(this.room, this.role === 'desktop' ? 'mobile' : 'desktop', bytes.subarray(0, FULL_BINARY.header)))
    decipher.setAuthTag(bytes.subarray(-FULL_BINARY.tag))
    const plain = Buffer.concat([decipher.update(bytes.subarray(FULL_BINARY.header, -FULL_BINARY.tag)), decipher.final()])
    if (header.seq <= prior) return
    if (header.seq !== prior + 1) throw new Error('mobile sequence gap')
    const result: unknown = header.kind === 2 ? plain : JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain))
    this.received.set(header.epoch, header.seq)
    return result
  }

  /** Erase owned key buffers when the authorization ends. */
  dispose(): void { this.disposed = true; this.sendKey.fill(0); this.receiveKey.fill(0); this.received.clear() }

  /** Start a fresh outbound generation after an authenticated browser hello. */
  rotateSend(): void {
    if (this.disposed) throw new Error('mobile authorization ended')
    this.epoch = randomBytes(16).toString('base64url'); this.sequence = 0
  }

  private aad(direction: string, epoch: string, seq: number): Buffer {
    return Buffer.from(`dsh-mobile/v1|${this.room}|${direction}|${epoch}|${seq}`)
  }
}
