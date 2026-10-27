import { gunzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { expect, it, vi } from 'vitest'
import { FullCarrier } from '../src/full-carrier.ts'
import { isRecord } from '../src/protocol.ts'
import type { FullPacketLane } from '../src/full-packets.ts'

/** The paths under test forward the Peer without reading more than its caller identity. */
const peer = { principal: { kind: 'owner' } } as PeerScope

it('dispatches a registered plugin RPC channel before the resource reader', async () => {
  const ctx = new Context()
  const readResource = vi.fn(async () => new Response(null, { status: 405 }))
  const dispatchRpc = vi.fn(async () => Response.json({
    type: 'server-response',
    rpcId: 'automation-snapshot',
    result: { ok: true, value: { tasks: [] } },
  }))
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    dispatchRpc,
  })
  ctx.provide('webServer', { readResource })
  const frames: Record<string, unknown>[] = []
  const carrier = new FullCarrier(ctx, async (frame) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    frames.push(frame)
    if (frame.type === 'response') carrier.accept({ type: 'response-pull', id: 'automation-snapshot-0001' })
  }, peer)
  try {
    carrier.accept({
      type: 'fetch',
      id: 'automation-snapshot-0001',
      url: '/dsh-automation/snapshot',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        type: 'client-request', rpcId: 'automation-snapshot', method: 'snapshot', payload: {},
      })).toString('base64url'),
    })
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'end')).toBe(true) })
    expect(frames[0]).toMatchObject({ type: 'response', status: 200 })
    const bytes = Buffer.concat(frames.filter(frame => frame.type === 'body')
      .map(frame => Buffer.from(String(frame.data), 'base64url')))
    expect(JSON.parse(bytes.toString())).toEqual({
      type: 'server-response',
      rpcId: 'automation-snapshot',
      result: { ok: true, value: { tasks: [] } },
    })
    expect(dispatchRpc).toHaveBeenCalledTimes(1)
    expect(readResource).not.toHaveBeenCalled()
  } finally { await carrier.settled(); await ctx.fiber.dispose() }
})

it('leaves a request no channel owns to the resource reader', async () => {
  const ctx = new Context()
  const readResource = vi.fn(async () => new Response(null, { status: 405 }))
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    dispatchRpc: () => undefined,
  })
  ctx.provide('webServer', { readResource })
  const frames: Record<string, unknown>[] = []
  const carrier = new FullCarrier(ctx, async (frame) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    frames.push(frame)
  }, peer)
  try {
    carrier.accept({
      type: 'fetch',
      id: 'unclaimed-post-0001',
      url: '/unclaimed/snapshot',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{}').toString('base64url'),
    })
    await vi.waitFor(() => { expect(frames.some(frame => frame.type === 'end')).toBe(true) })
    expect(frames[0]).toMatchObject({ type: 'response', status: 405 })
    expect(readResource).toHaveBeenCalledTimes(1)
  } finally { await carrier.settled(); await ctx.fiber.dispose() }
})

it('writes response headers and demanded body without awaiting their peer acknowledgements', async () => {
  const ctx = new Context()
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    dispatchRpc: () => undefined,
  })
  ctx.provide('webServer', { readResource: async () => new Response('synthetic response') })
  const written: unknown[] = [], acknowledged: unknown[] = []
  const ending = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
  const carrier = new FullCarrier(ctx, async (frame) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    acknowledged.push(frame.type)
    ending.resolve(undefined)
    await release.promise
  }, peer, true, async (frame) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    written.push(frame.type)
    if (frame.type === 'response') carrier.accept({ type: 'response-pull', id: 'pipeline-http-0001' })
  })
  try {
    carrier.accept({ type: 'fetch', id: 'pipeline-http-0001', url: '/state.json', method: 'GET', headers: {} })
    await ending.promise
    expect(written).toEqual(['response', 'body'])
    expect(acknowledged).toEqual(['end'])
  } finally { release.resolve(undefined); await carrier.settled(); await ctx.fiber.dispose() }
})

it('offers short HTTP response bodies to the control lane', async () => {
  const ctx = new Context()
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    dispatchRpc: () => undefined,
  })
  ctx.provide('webServer', { readResource: async () => Response.json({ models: ['synthetic-model'] }) })
  const lanes: { type: unknown; lane: FullPacketLane | undefined }[] = []
  const ended = Promise.withResolvers<undefined>()
  const carrier = new FullCarrier(ctx, async (frame, lane) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    lanes.push({ type: frame.type, lane })
    if (frame.type === 'response') carrier.accept({ type: 'response-pull', id: 'short-response-0001' })
    if (frame.type === 'end') ended.resolve(undefined)
  }, peer, true)
  try {
    carrier.accept({ type: 'fetch', id: 'short-response-0001', url: '/state.json', method: 'GET', headers: {} })
    await ended.promise
    expect(lanes.find(frame => frame.type === 'body')?.lane).toBe('control')
    expect(lanes.find(frame => frame.type === 'end')?.lane).toBe('control')
  } finally { await carrier.settled(); await ctx.fiber.dispose() }
})

it.each([
  ['/assets/client.js', 'text/javascript', 200, true],
  ['/assets/client.css', 'text/css', 200, true],
  ['/assets/client.svg', 'image/svg+xml', 200, true],
  ['/assets/range.js', 'text/javascript', 206, false],
  ['/', 'text/html', 200, false],
  ['/state.json', 'application/json', 200, false],
])('streams %s without compressing private documents or partial responses', async (url, contentType, status, compressed) => {
  const ctx = new Context()
  const source = Array.from({ length: 40000 }, (_, index) =>
    `const entry${index} = "${(index * 2654435761 >>> 0).toString(16)}";\n`).join('')
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: async () => new Response(null, { status: 404 }) }),
    dispatchRpc: () => undefined,
  })
  ctx.provide('webServer', { readResource: async () => new Response(source, { status, headers: { 'content-type': contentType } }) })
  const frames: Record<string, unknown>[] = []
  let finish!: () => void
  const ended = new Promise<void>((resolve) => { finish = resolve })
  const carrier = new FullCarrier(ctx, async (value) => {
    if (!isRecord(value)) throw new Error('expected response frame')
    frames.push(value)
    if (value.type === 'response' || value.type === 'body') {
      queueMicrotask(() => { carrier.accept({ type: 'response-pull', id: 'compression-test-0001' }) })
    }
    if (value.type === 'end') finish()
  }, peer)
  try {
    carrier.accept({ type: 'fetch', id: 'compression-test-0001', url, method: 'GET', headers: {} })
    await ended
    expect(frames[0]?.compression).toBe(compressed ? 'gzip' : undefined)
    const bytes = Buffer.concat(frames.filter(frame => frame.type === 'body').map(frame => Buffer.from(String(frame.data), 'base64url')))
    expect((compressed ? gunzipSync(bytes) : bytes).toString() === source).toBe(true)
    if (compressed) {
      expect(bytes.length).toBeLessThan(Buffer.byteLength(source) / 2)
      expect(frames.filter(frame => frame.type === 'body')).toHaveLength(Math.ceil(bytes.length / (192 * 1024)))
    }
  } finally { await carrier.settled(); await ctx.fiber.dispose() }
})

it.each(['status', 'start', 'stop'])('denies phone-side mobile/%s enrollment controls before application dispatch', async (method) => {
  const ctx = new Context()
  const dispatch = vi.fn(async () => Response.json({ ok: true }))
  const open = vi.fn(async function* () { yield { ok: true } })
  ctx.provide('connection', {
    createSharedFetchHandler: () => ({ fetch: dispatch }),
    dispatchRpc: () => undefined,
  })
  ctx.provide('typertGateway', { wireStream: { open, failure: () => ({ code: 'gateway/forbidden' }) } })
  const frames: Record<string, unknown>[] = []
  const carrier = new FullCarrier(ctx, async (frame) => {
    if (!isRecord(frame)) throw new Error('expected response frame')
    frames.push(frame)
  }, peer)
  try {
    for (const [index, url] of [`/api/mobile/${method}`, `/api/unused/../mobile/${method}`].entries()) {
      carrier.accept({ type: 'fetch', id: `denied-mobile-http-${index}`, url, method: 'POST', headers: {},
        body: Buffer.from(JSON.stringify({ type: 'client-request', method: `mobile/${method}`, payload: { args: { target: 'app' } } })).toString('base64url') })
    }
    carrier.accept({ type: 'stream', id: 'denied-mobile-stream', endpoint: `mobile/${method}`, payload: { args: { target: 'browser' } } })
    await vi.waitFor(() => { expect(frames).toHaveLength(3) })
    expect(frames.every(frame => frame.type === 'error')).toBe(true)
    expect(dispatch).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  } finally { await carrier.settled(); await ctx.fiber.dispose() }
})
