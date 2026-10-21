import { describe, expect, it, vi } from 'vitest'
import { FullPackets, fullDownloadWindow, packetMuxSupport } from '../src/full-packets.ts'
import { packetBytes, partBytes, readPart } from '../src/full-binary.ts'
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
    expect(packetMuxSupport(undefined)).toBe(false)
    expect(packetMuxSupport(['packet-mux-v1'])).toBe(true)
    expect(packetMuxSupport(['another-feature'])).toBe(false)
    for (const value of [[], ['packet-mux-v1', 'packet-mux-v1'], ['INVALID'], 'packet-mux-v1', null]) {
      expect(() => packetMuxSupport(value)).toThrow('relay features')
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

  it('lets control fragments pass bulk packets only after packet multiplexing is negotiated', async () => {
    for (const multiplex of [false, true]) {
      const frames: Uint8Array[] = []
      const packets = new FullPackets(async (frame) => { frames.push(frame as Uint8Array) }, () => {}, 32, true, multiplex)
      let settled: Promise<unknown> | undefined
      try {
        const bulk = packets.write({ type: 'body', id: 'operation-id-0001', data: new Uint8Array(12000 * 3) }, 'bulk')
        const control = packets.write({ type: 'item', id: 'operation-id-0002', value: 'control' }, 'control')
        settled = Promise.allSettled([bulk.written, bulk.acknowledged, control.written, control.acknowledged])
        await Promise.all([bulk.written, control.written])
        const parts = frames.map(readPart)
        const firstId = parts[0]?.id
        expect(firstId).toBeDefined()
        const firstControl = parts.findIndex(part => part.id !== firstId)
        if (multiplex) expect(firstControl).toBe(1)
        else expect(firstControl).toBeGreaterThan(1)
        for (const frame of frames) await packets.accept(acknowledgement(frame))
        await Promise.all([bulk.acknowledged, control.acknowledged])
      } finally { packets.close(); await settled }
    }
  })

  it('reserves control capacity when bulk and realtime fragments share the window', async () => {
    const frames: object[] = []
    const packets = new FullPackets(async (frame) => { frames.push(frame) }, () => {}, 8, true, true)
    const bulk = packets.write({ type: 'body', id: 'operation-id-0001', data: new Uint8Array(120000) }, 'bulk')
    const realtime = packets.write({ type: 'item', id: 'operation-id-0002', value: 'x'.repeat(30000) }, 'realtime')
    const settled = Promise.allSettled([bulk.written, bulk.acknowledged, realtime.written, realtime.acknowledged])
    let control: ReturnType<FullPackets['write']> | undefined
    try {
      await expect.poll(() => frames.length).toBe(7)
      control = packets.write({ type: 'cancel', id: 'operation-id-0003' })
      await control.written
      expect(frames).toHaveLength(8)
      expect(readPart(frames[7] as Uint8Array).end).toBe(true)
    } finally {
      packets.close()
      await settled
      await Promise.allSettled(control ? [control.written, control.acknowledged] : [])
    }
  })

  it('does not start another packet beyond the peer aggregate reassembly budget', async () => {
    const received: unknown[] = []
    const frames: Uint8Array[] = []
    const endpoints: { receiver?: FullPackets } = {}
    const sender = new FullPackets(async (frame) => {
      frames.push(frame as Uint8Array)
      await endpoints.receiver?.accept(frame)
    }, () => {}, 32, true, true)
    const receiver = new FullPackets(async (frame) => { await sender.accept(frame) }, value => received.push(value), 8, true, true)
    endpoints.receiver = receiver
    const bulk = sender.write({ type: 'item', id: 'operation-id-0001', value: 'x'.repeat(16 * 1024 * 1024 - 128) }, 'bulk')
    const control = sender.write({ type: 'item', id: 'operation-id-0002', value: 'x'.repeat(32000) }, 'control')
    const settled = Promise.allSettled([bulk.written, bulk.acknowledged, control.written, control.acknowledged])
    try {
      await Promise.all([bulk.acknowledged, control.acknowledged])
      const parts = frames.map(readPart)
      const firstId = parts[0]!.id
      const firstControl = parts.findIndex(part => part.id !== firstId)
      expect(parts[firstControl - 1]?.end).toBe(true)
      expect(received).toHaveLength(2)
    } finally { sender.close(); receiver.close(); await settled }
  })

  it('keeps cancellation behind its own start packet while unrelated control passes', async () => {
    const frames: object[] = []
    const received: unknown[] = []
    const endpoints: { receiver?: FullPackets } = {}
    const sender = new FullPackets(async (frame) => {
      frames.push(frame)
      await endpoints.receiver?.accept(frame)
    }, () => {}, 8, true, true)
    const receiver = new FullPackets(async (frame) => { await sender.accept(frame) }, value => received.push(value), 8, true, true)
    endpoints.receiver = receiver
    const start = sender.write({ type: 'stream', id: 'operation-id-0001', payload: 'x'.repeat(120000) })
    const cancel = sender.write({ type: 'cancel', id: 'operation-id-0001' })
    const unrelated = sender.write({ type: 'fetch', id: 'operation-id-0002' })
    const settled = Promise.allSettled([start, cancel, unrelated].flatMap(value => [value.written, value.acknowledged]))
    try {
      await Promise.all([start.acknowledged, cancel.acknowledged, unrelated.acknowledged])
      expect(received).toEqual([
        { type: 'fetch', id: 'operation-id-0002' },
        { type: 'stream', id: 'operation-id-0001', payload: 'x'.repeat(120000) },
        { type: 'cancel', id: 'operation-id-0001' },
      ])
    } finally { sender.close(); receiver.close(); await settled }
  })

  it.each([false, true])('does not deliver after closing during an ACK write with multiplex=%s', async (multiplex) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const receive = vi.fn()
    const packets = new FullPackets(async () => { entered.resolve(undefined); await release.promise }, receive, 8, true, multiplex)
    const accepting = packets.accept(partBytes(Buffer.alloc(16, 1).toString('base64url'), 0, true,
      packetBytes({ type: 'cancel', id: 'operation-id-0001' })))
    try {
      await entered.promise
      packets.close()
      release.resolve(undefined)
      await accepting
      expect(receive).not.toHaveBeenCalled()
    } finally { packets.close(); release.resolve(undefined); await accepting }
  })

  it('reassembles bounded interleaved packets only when multiplexing is negotiated', async () => {
    const firstId = Buffer.alloc(16, 1).toString('base64url')
    const secondId = Buffer.alloc(16, 2).toString('base64url')
    const first = packetBytes({ type: 'body', id: 'operation-id-0001', data: new Uint8Array(12001).fill(7) })
    const second = packetBytes({ type: 'item', id: 'operation-id-0002', value: 'control' })
    const interleaved = [
      partBytes(firstId, 0, false, first.subarray(0, 12000)),
      partBytes(secondId, 0, true, second),
      partBytes(firstId, 1, true, first.subarray(12000)),
    ]
    const legacy = new FullPackets(async () => {}, () => {}, 8, true)
    const received: unknown[] = []
    const multiplexed = new FullPackets(async () => {}, value => received.push(value), 8, true, true)
    try {
      await legacy.accept(interleaved[0])
      await expect(legacy.accept(interleaved[1])).rejects.toThrow('fragment gap')
      for (const fragment of interleaved) await multiplexed.accept(fragment)
      expect(received[0]).toEqual({ type: 'item', id: 'operation-id-0002', value: 'control' })
      expect(received[1]).toMatchObject({ type: 'body', id: 'operation-id-0001' })
      const body = received[1]
      if (!isRecord(body) || !(body.data instanceof Uint8Array)) throw new Error('expected raw body')
      expect(Buffer.from(body.data)).toEqual(Buffer.alloc(12001, 7))
    } finally { legacy.close(); multiplexed.close() }
  })

  it('bounds incomplete multiplexed packets and closes on reassembly timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const failed = vi.fn()
    const packets = new FullPackets(async () => {}, () => {}, 8, true, true, failed)
    try {
      for (let index = 0; index < 8; index++) {
        await packets.accept(partBytes(Buffer.alloc(16, index).toString('base64url'), 0, false, new Uint8Array([index])))
      }
      await expect(packets.accept(partBytes(Buffer.alloc(16, 9).toString('base64url'), 0, false, new Uint8Array([9]))))
        .rejects.toThrow('reassembly limit')
      await vi.advanceTimersByTimeAsync(30000)
      expect(failed).toHaveBeenCalledOnce()
      expect(failed.mock.calls[0]?.[0]).toMatchObject({ message: 'fragment reassembly timeout' })
      await expect(packets.send({ type: 'item' })).rejects.toThrow('closed')
    } finally {
      packets.close()
      vi.useRealTimers()
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
