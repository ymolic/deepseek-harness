/** Binary-v1 framing retains the existing fragment, packet and socket budgets. */
import { gzip } from 'node:zlib'
import { promisify } from 'node:util'

const compress = promisify(gzip)

/** Fixed binary-v1 byte limits; encoded bodies remain demand-driven. */
export const FULL_BINARY = { chunk: 12000, packet: 16 * 1024 * 1024, plain: 32768, header: 36, tag: 16 } as const
const operationId = /^[A-Za-z0-9_-]{16,64}$/
const maxIndex = Math.ceil(FULL_BINARY.packet / FULL_BINARY.chunk) - 1

/**
 * @param value - optional relay envelope advertisement.
 * @returns binary support; missing capabilities retain JSON, malformed lists fail.
 */
export function binaryRelaySupport(value: unknown): boolean {
  if (value === undefined) return false
  if (!Array.isArray(value) || value.length < 1 || value.length > 8
    || !value.every(item => typeof item === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(item))
    || new Set(value).size !== value.length || !value.includes('json')) throw new Error('invalid envelope capabilities')
  return value.includes('binary-v1')
}

/** @param bytes - complete sealed WS message. @returns validated public fields, before authentication. */
export function binaryHeader(bytes: Uint8Array) {
  if (bytes.length < FULL_BINARY.header + FULL_BINARY.tag + 1 || bytes.length > FULL_BINARY.header + FULL_BINARY.plain + FULL_BINARY.tag
    || bytes[0] !== 0x44 || bytes[1] !== 0x53 || bytes[2] !== 2 || bytes[3] !== 1 && bytes[3] !== 2) throw new Error('invalid binary frame')
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4)
  if (seq < 1 || seq > 100000) throw new Error('invalid binary sequence')
  return { seq, kind: bytes[3], epoch: Buffer.from(bytes.subarray(8, 24)).toString('base64url'), iv: bytes.subarray(24, 36) }
}

/**
 * @param context - HKDF traffic context including both handshake nonces.
 * @param direction - sender role.
 * @param header - bytes 0..35.
 * @returns domain-separated authenticated data.
 */
export function binaryAAD(context: string, direction: string, header: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`dsh-mobile/binary-v1\0${context}\0${direction}\0`), header])
}

/** @param value - control or raw body frame. @returns one bounded application packet without base64 body expansion. */
export function packetBytes(value: object): Buffer {
  let bytes: Buffer
  if ('type' in value && value.type === 'compressed-item') {
    if (Object.keys(value).length !== 4 || !('id' in value) || typeof value.id !== 'string' || !operationId.test(value.id)
      || !('size' in value) || typeof value.size !== 'number' || !Number.isSafeInteger(value.size)
      || value.size < 2 || value.size > FULL_BINARY.packet
      || !('data' in value) || !(value.data instanceof Uint8Array) || value.data.length < 1) throw new Error('invalid compressed item')
    const header = Buffer.alloc(6 + value.id.length)
    header[0] = 4; header[1] = value.id.length; header.write(value.id, 2); header.writeUInt32BE(value.size, 2 + value.id.length)
    bytes = Buffer.concat([header, value.data])
  } else if ('type' in value && (value.type === 'body' || value.type === 'request-body')) {
    const max = value.type === 'body' ? 192 * 1024 : 48 * 1024
    if (Object.keys(value).length !== 3 || !('id' in value) || typeof value.id !== 'string' || !operationId.test(value.id)
      || !('data' in value) || !(value.data instanceof Uint8Array) || value.data.length < 1 || value.data.length > max) throw new Error('invalid binary body')
    bytes = Buffer.concat([Buffer.from([value.type === 'body' ? 2 : 3, value.id.length]), Buffer.from(value.id), value.data])
  } else bytes = Buffer.concat([Buffer.from([1]), Buffer.from(JSON.stringify(value))])
  if (bytes.length > FULL_BINARY.packet) throw new Error('packet limit')
  return bytes
}

/**
 * Compress a stream item before encryption, retaining its original encoding when gzip does not save bytes.
 * @param frame - complete stream item with its operation id.
 * @param minimumBytes - validated minimum packet size; zero disables compression.
 * @returns the original item or an internal binary-v1 compressed packet representation.
 */
export async function compressedItem(frame: { type: 'item'; id: string; value: unknown }, minimumBytes: number): Promise<object> {
  if (minimumBytes === 0) return frame
  const bytes = packetBytes(frame)
  if (bytes.length < minimumBytes) return frame
  const data = await compress(bytes)
  if (data.length + 6 + frame.id.length >= bytes.length) return frame
  return { type: 'compressed-item', id: frame.id, size: bytes.length, data }
}

/** @param bytes - reassembled authenticated packet. @returns decoded control or raw body; rejects unsupported tags, ids and sizes. */
export function readPacket(bytes: Uint8Array): unknown {
  if (bytes.length < 2 || bytes.length > FULL_BINARY.packet) throw new Error('invalid binary packet')
  if (bytes[0] === 1) {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(1)))
    if (value !== null && typeof value === 'object' && 'type' in value
      && (value.type === 'body' || value.type === 'request-body')) throw new Error('invalid binary body')
    return value
  }
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint8(1)
  const max = bytes[0] === 2 ? 192 * 1024 : 48 * 1024
  if (bytes[0] !== 2 && bytes[0] !== 3 || length < 16 || length > 64 || bytes.length <= 2 + length
    || bytes.length - 2 - length > max) throw new Error('invalid binary body')
  const id = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(2, 2 + length))
  if (!operationId.test(id) || id.length !== length) throw new Error('invalid binary operation')
  return { type: bytes[0] === 2 ? 'body' : 'request-body', id, data: bytes.subarray(2 + length) }
}

/**
 * @param id - locally generated fragment id.
 * @param index - fragment ordinal.
 * @param end - final fragment.
 * @param payload - bounded packet slice.
 * @returns raw fragment.
 */
export function partBytes(id: string, index: number, end: boolean, payload: Uint8Array): Buffer {
  const bytes = Buffer.alloc(21 + payload.length)
  bytes.set(Buffer.from(id, 'base64url')); bytes.writeUInt32BE(index, 16); bytes[20] = end ? 1 : 0; bytes.set(payload, 21)
  return bytes
}

/** @param bytes - authenticated fragment plaintext. @returns validated fragment fields; empty payloads and excess ordinals fail. */
export function readPart(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 22 || bytes.length > 21 + FULL_BINARY.chunk || view.getUint8(20) > 1) throw new Error('invalid binary fragment')
  const index = view.getUint32(16)
  if (index > maxIndex) throw new Error('binary fragment limit')
  return { type: 'part', id: Buffer.from(bytes.subarray(0, 16)).toString('base64url'), index, end: bytes[20] === 1, data: bytes.subarray(21) }
}
