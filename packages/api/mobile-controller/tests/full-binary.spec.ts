/** Binary parsing, AEAD vectors and unchanged demand/window admission. */
import { randomBytes } from 'node:crypto'
import { expect, it } from 'vitest'
import { MobileCipher, isRecord } from '../src/protocol.ts'
import { FULL_BINARY, binaryRelaySupport, binaryHeader, packetBytes, readPacket, partBytes, readPart } from '../src/full-binary.ts'
import { FullPackets } from '../src/full-packets.ts'
import vectors from './binary-v1.json' with { type: 'json' }

const key = Buffer.from(Array.from({ length: 32 }, (_, index) => index))
const id = 'AAECAwQFBgcICQoLDA0ODw'

it('requires bounded, unique relay capabilities with JSON fallback', () => {
  expect(binaryRelaySupport(undefined)).toBe(false)
  expect(binaryRelaySupport(['json'])).toBe(false)
  expect(binaryRelaySupport(['json', 'binary-v1'])).toBe(true)
  expect(binaryRelaySupport(['future', 'json'])).toBe(false)
  for (const value of [null, 'binary-v1', [], ['binary-v1'], ['json', 'json'], ['json', 1],
    ['json', 'INVALID'], Array.from({ length: 9 }, (_, index) => `v${index}`)]) {
    expect(() => binaryRelaySupport(value)).toThrow('capabilities')
  }
})

it.each(vectors)('decodes the shared $direction AES-GCM vector and authenticates every header byte', (vector) => {
  const role = vector.direction === 'desktop' ? 'mobile' : 'desktop'
  const codec = new MobileCipher(key, vector.context, role)
  const frame = Buffer.from(vector.frame, 'hex')
  const expected: unknown = vector.direction === 'desktop' ? Buffer.from(vector.plain, 'hex')
    : JSON.parse(Buffer.from(vector.plain, 'hex').toString())
  try {
    for (let offset = 0; offset < FULL_BINARY.header + FULL_BINARY.tag; offset++) {
      const bad = Buffer.from(frame)
      const at = offset < FULL_BINARY.header ? offset : frame.length - FULL_BINARY.tag + offset - FULL_BINARY.header
      bad[at] = bad[at]! ^ 1
      expect(() => codec.openBinary(bad)).toThrow()
    }
    expect(() => new MobileCipher(key, `${vector.context}:other`, role).openBinary(frame)).toThrow()
    expect(() => new MobileCipher(key, vector.context, vector.direction === 'desktop' ? 'desktop' : 'mobile').openBinary(frame)).toThrow()
    expect(codec.openBinary(frame)).toEqual(expected)
    expect(codec.openBinary(frame)).toBeUndefined()
  } finally { codec.dispose() }
})

it('shares sequence across ready and binary frames, rejects gaps, and ends on disposal', () => {
  const host = new MobileCipher(key, 'scope'), phone = new MobileCipher(key, 'scope', 'mobile')
  try {
    expect(phone.open(host.seal({ type: 'ready', protocol: 2 }))).toEqual({ type: 'ready', protocol: 2 })
    const first = host.sealBinary({ type: 'ack', id, index: 0 }), next = host.sealBinary(new Uint8Array([1, 2, 255]))
    expect(binaryHeader(first).seq).toBe(2)
    expect(() => phone.openBinary(next)).toThrow('sequence gap')
    expect(phone.openBinary(first)).toEqual({ type: 'ack', id, index: 0 })
    expect(phone.openBinary(next)).toEqual(Buffer.from([1, 2, 255]))
    expect(() => host.sealBinary(new Uint8Array(FULL_BINARY.plain + 1))).toThrow('limit')
    expect(() => host.sealBinary(new Uint8Array())).toThrow('limit')
    for (let index = 1; index < 32; index++) {
      host.rotateSend(); expect(phone.openBinary(host.sealBinary({ type: 'ack' }))).toEqual({ type: 'ack' })
    }
    host.rotateSend(); expect(() => phone.openBinary(host.sealBinary({ type: 'ack' }))).toThrow('generation limit')
  } finally { host.dispose(); phone.dispose() }
  expect(() => host.openBinary(new Uint8Array())).toThrow('authorization ended')
  expect(() => host.sealBinary({})).toThrow('authorization ended')
})

it('rejects truncated, oversized, unknown and empty binary values', () => {
  const vector = Buffer.from(vectors[0]!.frame, 'hex')
  for (const bytes of [vector.subarray(0, 52), new Uint8Array(32821), new Uint8Array(), new Uint8Array([4, 0])]) {
    expect(() => binaryHeader(bytes)).toThrow()
  }
  for (const bytes of [new Uint8Array(), new Uint8Array([4, 16]), new Uint8Array([2, 16]),
    Buffer.concat([Buffer.from([2, 16]), Buffer.from('!'.repeat(16)), Buffer.from([1])]),
    Buffer.from([1, 0xff]), Buffer.from([1, ...Buffer.from('{"type":"body","id":"x","data":"YWJj"}')])]) {
    expect(() => readPacket(bytes)).toThrow()
  }
  for (const value of [{ type: 'body', id, data: 'YWJj' }, { type: 'body', id: 'short', data: new Uint8Array([1]) },
    { type: 'body', id, data: new Uint8Array() }, { type: 'request-body', id, data: new Uint8Array(48 * 1024 + 1) },
    { type: 'large', text: 'a'.repeat(FULL_BINARY.packet) }]) expect(() => packetBytes(value)).toThrow()
  expect(readPacket(packetBytes({ type: 'response-pull', id }))).toEqual({ type: 'response-pull', id })
  for (const bytes of [new Uint8Array(21), new Uint8Array(12022), partBytes(id, 0, false, new Uint8Array([1])),
    partBytes(id, 2000, true, new Uint8Array([1]))]) {
    if (bytes.length === 22 && new DataView(bytes.buffer, bytes.byteOffset).getUint32(16) === 0) bytes[20] = 2
    expect(() => readPart(bytes)).toThrow()
  }
})

it.each(['body', 'request-body'])('round-trips %s as raw bytes rather than base64', (type) => {
  const value = { type, id: 'operation-id-0001', data: new Uint8Array([0, 255, 17, 254]) }
  const encoded = packetBytes(value)
  expect(encoded.length).toBe(2 + value.id.length + value.data.length)
  expect(readPacket(encoded)).toEqual({ ...value, data: Buffer.from(value.data) })
})

it('reassembles raw 192KiB bodies, acknowledges them, and cancels a bounded pending sender', async () => {
  const received: unknown[] = [], wire: object[] = [], faults: unknown[] = []
  const host = new FullPackets(async (value) => {
    wire.push(value); queueMicrotask(() => { void phone.accept(value).catch((error: unknown) => faults.push(error)) })
  }, () => {}, 32, true)
  const phone = new FullPackets(async (value) => {
    queueMicrotask(() => { void host.accept(value).catch((error: unknown) => faults.push(error)) })
  }, value => received.push(value), 8, true)
  try {
    const value = { type: 'body', id: 'operation-id-0001', data: randomBytes(192 * 1024) }
    await host.send(value)
    expect(received).toEqual([value])
    expect(wire.every(frame => frame instanceof Uint8Array)).toBe(true)
    expect(wire.reduce((size, frame) => size + (frame instanceof Uint8Array ? frame.byteLength + 52 : 0), 0))
      .toBeLessThan(value.data.length * 1.01)
    expect(faults).toEqual([])
    const blocked = new FullPackets(async () => {}, () => {}, 8, true)
    const pending = blocked.send({ type: 'request' })
    blocked.close()
    await expect(pending).rejects.toThrow('closed')
    await expect(phone.accept(partBytes(id, 1, true, new Uint8Array([1])))).rejects.toThrow('gap')
    const legacy = { type: 'part', id, index: 0, end: true, data: 'YWJj' }
    expect(isRecord(legacy)).toBe(true)
    await expect(phone.accept(legacy)).rejects.toThrow('invalid fragment')
  } finally { host.close(); phone.close() }
})
