import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it } from 'vitest'
import { FullCarrier } from '../src/full-carrier.ts'
import { FullPackets } from '../src/full-packets.ts'
import { isRecord } from '../src/protocol.ts'

const peer = { principal: { kind: 'owner' } } as PeerScope
const request = { type: 'stream', id: 'stream-pipeline-0001', endpoint: 'test/follow', payload: {} }

function streamFixture(binary: boolean, source: (signal: AbortSignal) => AsyncIterable<unknown>, window = 4) {
  const ctx = new Context()
  ctx.provide('typertGateway', {
    wireStream: {
      open: async (_endpoint: string, _payload: unknown, _uplink: AsyncIterable<unknown>,
        _peer: PeerScope, signal: AbortSignal) => source(signal),
      failure: () => ({ code: 'gateway/internal', message: 'Synthetic stream failure', details: {} }),
    },
  })
  const frames: Record<string, unknown>[] = []
  const held: object[] = []
  const deliveries: Promise<void>[] = []
  const finished = Promise.withResolvers<undefined>()
  let automatic = false
  const phone = new FullPackets(async (frame) => {
    if (automatic) await host.accept(frame)
    else held.push(frame)
  }, (value) => {
    if (!isRecord(value)) throw new Error('expected carrier frame')
    frames.push(value)
    if (value.type === 'finish' || value.type === 'error') finished.resolve(undefined)
  }, 8, binary)
  const host = new FullPackets(frame => phone.accept(frame), () => {}, window, binary)
  const carrier = new FullCarrier(ctx, frame => host.send(frame), peer, binary, (frame) => {
    const delivery = host.write(frame)
    deliveries.push(delivery.acknowledged)
    void delivery.acknowledged.catch((_error: unknown) => { host.close() })
    return delivery.written
  })
  return {
    carrier, frames, finished: finished.promise,
    async resume() {
      automatic = true
      for (const frame of held.splice(0)) await host.accept(frame)
    },
    disconnect() { host.close(); phone.close(); carrier.close() },
    async close() {
      host.close(); phone.close()
      await carrier.settled()
      await Promise.allSettled(deliveries)
      await ctx.fiber.dispose()
    },
  }
}

it.each([false, true])('pipelines ordered stream items within the fragment budget with binary=%s', async (binary) => {
  let produced = 0
  const fixture = streamFixture(binary, async function* () {
    for (let index = 0; index < 12; index++) {
      produced++
      yield { index, text: '\u4e2d\u6587' }
    }
  })
  try {
    fixture.carrier.accept(request)
    await expect.poll(() => produced).toBe(5)
    expect(fixture.frames.map(frame => frame.value)).toEqual(Array.from({ length: 4 }, (_, index) => ({ index, text: '\u4e2d\u6587' })))
    expect(fixture.frames.every(frame => frame.type === 'item')).toBe(true)
    await fixture.resume()
    await fixture.finished
    expect(fixture.frames.map(frame => frame.type)).toEqual([...Array<string>(12).fill('item'), 'finish'])
    expect(fixture.frames.slice(0, -1).map(frame => frame.value)).toEqual(
      Array.from({ length: 12 }, (_, index) => ({ index, text: '\u4e2d\u6587' })),
    )
  } finally { await fixture.close() }
})

it('cancels a window-blocked source without terminating another stream on the same connection', async () => {
  let produced = 0, stopped = false
  const fixture = streamFixture(true, async function* (signal) {
    try {
      while (!signal.aborted && produced < 16) yield { index: produced++ }
    } finally { stopped = true }
  })
  try {
    fixture.carrier.accept(request)
    await expect.poll(() => produced).toBe(5)
    fixture.carrier.accept({ type: 'cancel', id: request.id })
    await fixture.resume()
    await expect.poll(() => stopped).toBe(true)
    expect(produced).toBe(5)
    expect(fixture.frames.some(frame => frame.type === 'finish' || frame.type === 'error')).toBe(false)
    const next = { ...request, id: 'stream-pipeline-0002' }
    fixture.carrier.accept(next)
    await expect.poll(() => fixture.frames.some(frame => frame.id === next.id)).toBe(true)
    fixture.carrier.accept({ type: 'cancel', id: next.id })
  } finally { await fixture.close() }
})

it('discards old-epoch queued items and admits a fresh stream after transport loss', async () => {
  const source = async function* () { for (let index = 0; index < 12; index++) yield { index } }
  const previous = streamFixture(true, source)
  const next = streamFixture(true, source)
  try {
    previous.carrier.accept(request)
    await expect.poll(() => previous.frames.length).toBe(4)
    previous.disconnect()
    await previous.carrier.settled()
    const receivedBefore = previous.frames.length
    await previous.resume()
    await next.resume()
    next.carrier.accept(request)
    await next.finished
    expect(previous.frames).toHaveLength(receivedBefore)
    expect(next.frames.slice(0, -1).map(frame => frame.value)).toEqual(Array.from({ length: 12 }, (_, index) => ({ index })))
    expect(next.frames.at(-1)?.type).toBe('finish')
  } finally { await previous.close(); await next.close() }
})

it('delivers already-written items before a terminal source failure', async () => {
  const fixture = streamFixture(true, async function* () {
    yield { index: 0 }
    yield { index: 1 }
    throw new Error('synthetic source failure')
  })
  try {
    await fixture.resume()
    fixture.carrier.accept(request)
    await fixture.finished
    expect(fixture.frames.map(frame => frame.type)).toEqual(['item', 'item', 'error'])
    expect(fixture.frames.at(-1)?.failure).toMatchObject({ code: 'gateway/internal' })
  } finally { await fixture.close() }
})
