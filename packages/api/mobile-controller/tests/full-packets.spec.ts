import { describe, expect, it, vi } from 'vitest'
import { FullPackets, fullDownloadWindow } from '../src/full-packets.ts'
import { readPart } from '../src/full-binary.ts'
import { isRecord } from '../src/protocol.ts'

function acknowledgement(value: object): object {
  const frame = value instanceof Uint8Array ? readPart(value) : value
  if (!isRecord(frame)) throw new Error('expected fragment')
  return { type: 'ack', id: frame.id, index: frame.index }
}

describe('full-client encrypted packet framing', () => {
  it('caps downloads by both deployment and relay limits and retains older-relay admission', () => {
    expect(fullDownloadWindow(undefined, 32)).toBe(8)
    expect(fullDownloadWindow(undefined, 1)).toBe(1)
    expect(fullDownloadWindow(32, 32)).toBe(32)
    expect(fullDownloadWindow(32, 8)).toBe(8)
    expect(fullDownloadWindow(8, 32)).toBe(8)
    for (const value of [0, 33, 1.5, '32', null]) {
      expect(() => fullDownloadWindow(value, 32)).toThrow('fragment window')
    }
  })

  it('reassembles a multibyte bundle above the frame limit with bounded fragments', async () => {
    const received: unknown[] = []
    const frames: object[] = []
    const left = new FullPackets(async (value) => {
      frames.push(value)
      queueMicrotask(() => { void right.accept(value) })
    }, () => {}, 32)
    const right = new FullPackets(async (value) => {
      queueMicrotask(() => { void left.accept(value) })
    }, value => received.push(value), 8)
    try {
      const value = { type: 'bundle', source: '中文'.repeat(40000) }
      await left.send(value)
      expect(received).toEqual([value])
      expect(frames.length).toBeGreaterThan(10)
      expect(Math.max(...frames.map(value => Buffer.byteLength(JSON.stringify(value))))).toBeLessThan(32768)
    } finally { left.close(); right.close() }
  })

  it('rejects fragment gaps, excess packet bytes and sends after close', async () => {
    const packets = new FullPackets(async () => {}, () => {}, 32)
    await expect(packets.accept({ type: 'part', id: 'a'.repeat(22), index: 1, data: '', end: true })).rejects.toThrow('gap')
    await expect(packets.send({ body: 'a'.repeat(16 * 1024 * 1024) })).rejects.toThrow('limit')
    packets.close()
    await expect(packets.send({ type: 'request' })).rejects.toThrow('closed')
  })

  it('cancels a sender waiting for an acknowledgement on disconnect', async () => {
    const packets = new FullPackets(async () => {}, () => {}, 32)
    const sending = packets.send({ type: 'request' })
    await Promise.resolve()
    packets.close()
    await expect(sending).rejects.toThrow('closed')
  })

  it.each([1, 8, 32])('shares a %i-fragment window across concurrent requests without exceeding it', async (windowSize) => {
    const frames: object[] = []
    const blocked = Promise.withResolvers<undefined>()
    const packets = new FullPackets(async (frame) => {
      frames.push(frame)
      if (frames.length === windowSize) blocked.resolve(undefined)
    }, () => {}, windowSize)
    const sending = Array.from({ length: windowSize + 4 }, (_, index) => packets.send({ type: 'request', index }))
    const settled = Promise.allSettled(sending)
    try {
      await blocked.promise
      await Promise.resolve()
      expect(frames).toHaveLength(windowSize)
      const first = frames[0]
      if (!first || !('id' in first) || !('index' in first)) throw new Error('expected fragment')
      await packets.accept({ type: 'ack', id: first.id, index: first.index })
      await sending[0]
      await expect.poll(() => frames.length).toBe(windowSize + 1)
    } finally {
      packets.close()
      await settled
    }
  })

  it.each([false, true])('separates local writing from acknowledgement with binary=%s', async (binary) => {
    const frames: object[] = []
    const packets = new FullPackets(async (frame) => { frames.push(frame) }, () => {}, 8, binary)
    const delivery = packets.write({ type: 'item', value: 'ready' })
    let confirmed = false
    const confirmedTask = delivery.acknowledged.then(() => { confirmed = true }, () => undefined)
    try {
      await delivery.written
      expect(frames).toHaveLength(1)
      expect(confirmed).toBe(false)
      await packets.accept(acknowledgement(frames[0]!))
      await delivery.acknowledged
      expect(confirmed).toBe(true)
    } finally {
      packets.close()
      await confirmedTask
    }
  })

  it.each([1, 8, 32])('bounds pipelined writes by the shared %i-fragment window', async (windowSize) => {
    const frames: object[] = []
    const filled = Promise.withResolvers<undefined>()
    const packets = new FullPackets(async (frame) => {
      frames.push(frame)
      if (frames.length === windowSize) filled.resolve(undefined)
    }, () => {}, windowSize, true)
    const deliveries = Array.from({ length: windowSize + 2 }, (_, value) => packets.write({ type: 'item', value }))
    const settled = Promise.allSettled(deliveries.flatMap(delivery => [delivery.written, delivery.acknowledged]))
    try {
      await filled.promise
      await Promise.all(deliveries.slice(0, windowSize).map(delivery => delivery.written))
      expect(frames).toHaveLength(windowSize)
      await packets.accept(acknowledgement(frames[0]!))
      await deliveries[windowSize]!.written
      expect(frames).toHaveLength(windowSize + 1)
    } finally {
      packets.close()
      await settled
    }
  })

  it('rejects a written but unacknowledged packet and queued writes on disconnect', async () => {
    const packets = new FullPackets(async () => {}, () => {}, 1)
    const first = packets.write({ type: 'item', value: 1 })
    const next = packets.write({ type: 'item', value: 2 })
    const rejected = Promise.all([
      expect(first.acknowledged).rejects.toThrow('closed'),
      expect(next.written).rejects.toThrow('closed'),
      expect(next.acknowledged).rejects.toThrow('closed'),
    ])
    await first.written
    packets.close()
    await rejected
  })

  it('invalidates the transport when an acknowledgement times out after local writing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const packets = new FullPackets(async () => {}, () => {}, 8)
    try {
      const delivery = packets.write({ type: 'item', value: 1 })
      const expired = expect(delivery.acknowledged).rejects.toThrow('acknowledgement timeout')
      await delivery.written
      await vi.advanceTimersByTimeAsync(30000)
      await expired
      await expect(packets.send({ type: 'item', value: 2 })).rejects.toThrow('closed')
    } finally {
      packets.close()
      vi.useRealTimers()
    }
  })

  it('rejects both write phases for encoding and local transmit failures', async () => {
    const packets = new FullPackets(async () => { throw new Error('synthetic transmit failure') }, () => {}, 8)
    try {
      const circular: { self?: object } = {}
      circular.self = circular
      const invalid = packets.write(circular)
      await Promise.all([
        expect(invalid.written).rejects.toThrow(),
        expect(invalid.acknowledged).rejects.toThrow(),
      ])
      const failed = packets.write({ type: 'item', value: 1 })
      await Promise.all([
        expect(failed.written).rejects.toThrow('synthetic transmit failure'),
        expect(failed.acknowledged).rejects.toThrow('synthetic transmit failure'),
      ])
    } finally { packets.close() }
  })
})
