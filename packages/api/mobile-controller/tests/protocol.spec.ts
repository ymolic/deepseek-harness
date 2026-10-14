import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { MobileCipher, MOBILE_WIRE, mobileRequest } from '../src/protocol.ts'

const channel = 'browserchannel00000001'

describe('mobile text protocol', () => {
  it('admits only four exact commands without phone-supplied authority', () => {
    const id = 'message000000001'
    for (const value of [
      { type: 'hello', channel }, { type: 'sync', channel },
      { type: 'receipt', channel, id }, { type: 'send', channel, id, text: '你好' },
    ]) expect(mobileRequest(value)).toEqual(value)
    for (const value of [null, [], {}, { type: 'rpc', channel },
      { type: 'send', channel, id, text: ' ' }, { type: 'send', channel, id, text: 'x'.repeat(8001) },
      { type: 'send', channel, id, text: 'ok', sessionId: 'another-session' },
      { type: 'send', channel, id, text: 'ok', cwd: '/untrusted' },
      { type: 'send', channel, id, text: 'ok', permissions: 'full' },
      { type: 'hello', channel: 'short' }, { type: 'receipt', channel, id: 'short' },
    ]) expect(mobileRequest(value)).toBeUndefined()
  })

  it('authenticates direction, room, header and payload before advancing the receive sequence', () => {
    const key = randomBytes(32)
    const desktop = new MobileCipher(key, 'test-room')
    const mobile = new MobileCipher(key, 'test-room', 'mobile')
    const frame = mobile.seal({ type: 'hello', channel })
    expect(() => desktop.open({ ...frame, seq: 2 })).toThrow()
    expect(() => desktop.open({ ...frame, data: `${frame.data[0] === 'A' ? 'B' : 'A'}${frame.data.slice(1)}` })).toThrow()
    expect(() => mobile.open(frame)).toThrow()
    expect(() => new MobileCipher(key, 'different-room').open(frame)).toThrow()
    expect(desktop.open(frame)).toEqual({ type: 'hello', channel })
    expect(desktop.open(frame)).toBeUndefined()
    expect(mobile.open(desktop.seal({ type: 'state' }))).toEqual({ type: 'state' })
  })

  it('requires contiguous frames and a fresh bounded epoch after reconnect', () => {
    const key = randomBytes(32)
    const desktop = new MobileCipher(key, 'room')
    const mobile = new MobileCipher(key, 'room', 'mobile')
    const first = mobile.seal('first')
    const second = mobile.seal('second')
    expect(() => desktop.open(second)).toThrow('sequence gap')
    expect(desktop.open(first)).toBe('first')
    expect(desktop.open(second)).toBe('second')
    for (let index = 1; index < MOBILE_WIRE.maxGenerations; index++) {
      mobile.rotateSend()
      expect(desktop.open(mobile.seal('refresh'))).toBe('refresh')
    }
    mobile.rotateSend()
    expect(() => desktop.open(mobile.seal('excess'))).toThrow('generation limit')
  })

  it('bounds complete JSON and rejects traffic after key disposal', () => {
    const codec = new MobileCipher(randomBytes(32), 'room')
    expect(() => codec.seal('\u0000'.repeat(6000))).toThrow('frame limit')
    for (const input of [null, {}, { type: 'sealed', epoch: 'x', seq: 1, iv: 'x', data: 'x' }]) {
      expect(() => codec.open(input)).toThrow('invalid mobile frame')
    }
    codec.dispose()
    expect(() => codec.seal('ended')).toThrow('authorization ended')
    expect(() => codec.open({})).toThrow('authorization ended')
    expect(() =>{  codec.rotateSend() }).toThrow('authorization ended')
  })
})
