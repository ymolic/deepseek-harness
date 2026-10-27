/** Full-client dispatch through existing registered application services, never a network proxy. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-modules'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { FullPacketLane } from './full-packets.ts'
import { compressedItem } from './full-binary.ts'

const BODY_CHUNK = 192 * 1024
const id = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/)
const frameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fetch'), id, url: z.string().max(4096), method: z.enum(['GET', 'HEAD', 'POST']),
    headers: z.record(z.string(), z.string().max(4096)), body: z.string().max(12 * 1024 * 1024).optional(),
    upload: z.literal(true).optional() }).strict(),
  z.object({ type: z.literal('request-body'), id, data: z.union([
    z.string().max(64 * 1024).regex(/^[A-Za-z0-9_-]+$/),
    z.instanceof(Uint8Array).refine(value => value.length > 0 && value.length <= 48 * 1024),
  ]) }).strict(),
  z.object({ type: z.literal('request-end'), id }).strict(),
  z.object({ type: z.literal('response-pull'), id }).strict(),
  z.object({ type: z.literal('stream'), id, endpoint: z.string().max(512), payload: z.unknown() }).strict(),
  z.object({ type: z.literal('uplink'), id, value: z.unknown() }).strict(),
  z.object({ type: z.literal('uplink-end'), id }).strict(),
  z.object({ type: z.literal('cancel'), id }).strict(),
])

/** Coalesce gzip output so each acknowledged download carries a full bounded block. */
function compressedAsset(body: NonNullable<Response['body']>): NonNullable<Response['body']> {
  let buffer = new Uint8Array(BODY_CHUNK)
  let used = 0
  return body.pipeThrough(new CompressionStream('gzip')).pipeThrough(new TransformStream<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.length;) {
        const count = Math.min(buffer.length - used, chunk.length - offset)
        buffer.set(chunk.subarray(offset, offset + count), used)
        used += count
        offset += count
        if (used === buffer.length) {
          controller.enqueue(buffer)
          buffer = new Uint8Array(BODY_CHUNK)
          used = 0
        }
      }
    },
    flush(controller) { if (used > 0) controller.enqueue(buffer.subarray(0, used)) },
  }))
}

/** One requested upload chunk at a time, including cancellation before the next chunk arrives. */
class Upload {
  private receiver: { resolve(value: Uint8Array | null): void; reject(error: unknown): void } | undefined
  private ended = false
  readonly stream: ReadableStream<Uint8Array>
  constructor(pull: () => Promise<void>) {
    this.stream = new ReadableStream({
      pull: async (controller) => {
        const next = new Promise<Uint8Array | null>((resolve, reject) => { this.receiver = { resolve, reject } })
        // Attach a handler before a concurrent abort can reject the chunk.
        void next.catch(() => undefined)
        if (this.ended) this.receiver?.resolve(null)
        else await pull()
        const value = await next
        this.receiver = undefined
        if (value === null) controller.close()
        else controller.enqueue(value)
      },
      cancel: () => { this.end() },
    })
  }
  push(data: string | Uint8Array): void {
    if (this.ended || !this.receiver) throw new Error('unsolicited upload chunk')
    const receiver = this.receiver
    this.receiver = undefined
    receiver.resolve(typeof data === 'string' ? new Uint8Array(Buffer.from(data, 'base64url')) : data)
  }
  end(): void { this.ended = true; this.receiver?.resolve(null) }
}

class Inbox implements AsyncIterable<unknown> {
  private readonly items: unknown[] = []
  private wake: (() => void) | undefined
  private ended = false
  push(value: unknown): void {
    if (this.ended) return
    if (this.items.length >= 64) throw new Error('uplink limit')
    this.items.push(value)
    this.wake?.()
  }
  end(): void { this.ended = true; this.wake?.() }
  async *[Symbol.asyncIterator](): AsyncGenerator {
    while (!this.ended || this.items.length > 0) {
      if (this.items.length) yield this.items.shift()
      else await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

/** Adapt the existing module graph/rebuild subscriptions to the Client's SSE route. */
function moduleEvents(ctx: Context, signal: AbortSignal): Response {
  let dispose = (): void => {}
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (value: object): void => { controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)) }
      const graph = (): void => { write({ type: 'graph', graph: ctx.clientModules.graph() }) }
      const stopGraph = ctx.clientModules.onGraphChanged(graph)
      const stopRebuilt = ctx.clientModules.onRebuilt((id, rev) => { write({ type: 'rebuilt', id, rev }) })
      const abort = (): void => { dispose(); controller.close() }
      dispose = () => { stopGraph(); stopRebuilt(); signal.removeEventListener('abort', abort) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      else graph()
    },
    cancel() { dispose() },
  })
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
}

/** Owns cancellation and admission for one authenticated transport epoch. */
export class FullCarrier {
  private readonly operations = new Map<string, {
    abort: AbortController
    inbox: Inbox
    download: Inbox
    upload: Upload | undefined
    task: Promise<void>
  }>()
  private readonly seen = new Set<string>()
  private closed = false

  /**
   * @param ctx - services of the current application.
   * @param send - acknowledged packet writer with an optional latency class.
   * @param peer - caller identity dispatched requests speak for; the paired device's operator Peer.
   * @param binary - negotiated raw body encoding; omitted or false retains legacy base64.
   * @param writeStream - ordered, window-bounded local writer owning later acknowledgement failures; defaults to acknowledged writes.
   * @param compressionMinBytes - negotiated binary packet compression threshold; zero disables compression.
   */
  constructor(private readonly ctx: Context, private readonly send: (frame: object, lane?: FullPacketLane) => Promise<void>,
    private readonly peer: PeerScope, private readonly binary = false,
    private readonly writeStream: (frame: object, lane?: FullPacketLane) => Promise<void> = send,
    private readonly compressionMinBytes = 0) {}

  /** @param value - reassembled encrypted client frame. */
  accept(value: unknown): void {
    const frame = frameSchema.parse(value)
    if (this.closed) return
    if (frame.type === 'cancel') {
      const operation = this.operations.get(frame.id)
      operation?.abort.abort(); operation?.inbox.end(); operation?.download.end(); operation?.upload?.end()
      return
    }
    if (frame.type === 'request-body') {
      if (this.binary !== (frame.data instanceof Uint8Array)) throw new Error('unexpected body encoding')
      this.operations.get(frame.id)?.upload?.push(frame.data); return
    }
    if (frame.type === 'request-end') { this.operations.get(frame.id)?.upload?.end(); return }
    if (frame.type === 'response-pull') { this.operations.get(frame.id)?.download.push(null); return }
    if (frame.type === 'uplink-end') { this.operations.get(frame.id)?.inbox.end(); return }
    if (frame.type === 'uplink') { this.operations.get(frame.id)?.inbox.push(frame.value); return }
    // A transport epoch has no mutation replay path, including completed requests.
    if (this.seen.has(frame.id) || this.seen.size >= 10000 || this.operations.size >= 64) throw new Error('request admission limit')
    this.seen.add(frame.id)
    const operation: { abort: AbortController; inbox: Inbox; download: Inbox; upload: Upload | undefined; task: Promise<void> }
      = { abort: new AbortController(), inbox: new Inbox(), download: new Inbox(), upload: undefined, task: Promise.resolve() }
    this.operations.set(frame.id, operation)
    operation.task = (async () => {
      let responseStarted = false
      try {
        if (frame.type === 'fetch') {
          if (!frame.url.startsWith('/') || frame.url.startsWith('//')) throw new Error('invalid application path')
          const url = new URL(frame.url, 'https://dsh.invalid')
          if (url.origin !== 'https://dsh.invalid' || url.username || url.password || url.hash) throw new Error('invalid application path')
          if (url.pathname === '/api/mobile' || url.pathname.startsWith('/api/mobile/')) throw new Error('mobile authorization is desktop-only')
          const headers = new Headers()
          for (const [name, value] of Object.entries(frame.headers)) {
            if (!['content-type', 'accept', 'range'].includes(name.toLowerCase())) throw new Error('unsupported request header')
            headers.set(name, value)
          }
          if (frame.body !== undefined && !/^[A-Za-z0-9_-]*$/.test(frame.body)) throw new Error('invalid request bytes')
          if ((frame.body !== undefined || frame.upload) && frame.method !== 'POST' || frame.body !== undefined && frame.upload) throw new Error('unexpected request body')
          if (frame.upload) operation.upload = new Upload(() => this.send({ type: 'body-pull', id: frame.id }))
          const body = operation.upload?.stream ?? (frame.body === undefined ? undefined : new Uint8Array(Buffer.from(frame.body, 'base64url')))
          const init: RequestInit & { duplex: 'half' } = { method: frame.method, headers, signal: operation.abort.signal, duplex: 'half',
            ...(body === undefined ? {} : { body }) }
          const request = new Request(url, init)
          const response = url.pathname.startsWith('/api/')
            ? await this.ctx.connection.createSharedFetchHandler('/api').fetch(request, this.peer)
            : url.pathname === '/plugins/events' && frame.method === 'GET'
              ? moduleEvents(this.ctx, operation.abort.signal)
              // A plugin's own Connection RPC channel answers its paths, as it
              // does over HTTP; static resources and unclaimed paths fall through.
              : await this.ctx.connection.dispatchRpc(request, this.peer)
                ?? await this.ctx.webServer.readResource(request, this.peer)
          const responseHeaders: Record<string, string> = {}
          for (const name of ['content-type', 'content-disposition', 'content-length', 'content-range', 'accept-ranges', 'cache-control']) {
            const value = response.headers.get(name)
            if (value !== null) responseHeaders[name] = value
          }
          // Compress executable assets only; private documents and application data stay uncompressed.
          const compression = response.body !== null && response.status === 200 && frame.method === 'GET'
            && !url.pathname.startsWith('/api/')
            && /^(?:text\/javascript|application\/javascript|text\/css|image\/svg\+xml)(?:;|$)/i.test(responseHeaders['content-type'] ?? '')
            ? 'gzip' : undefined
          const bodyStream = compression === undefined || response.body === null ? response.body : compressedAsset(response.body)
          if (compression !== undefined) delete responseHeaders['content-length']
          responseHeaders['cache-control'] = 'no-store'
          await this.writeStream({ type: 'response', id: frame.id, status: response.status, headers: responseHeaders,
            ...(compression === undefined ? {} : { compression }) })
          responseStarted = true
          const reader = bodyStream?.getReader()
          const demand = operation.download[Symbol.asyncIterator]()
          if (reader) {
            try {
              while (!operation.abort.signal.aborted) {
                const next = await reader.read()
                if (next.done) break
                // Route responses can contain a large single chunk; bound each wire packet.
                for (let offset = 0; offset < next.value.length; offset += BODY_CHUNK) {
                  await demand.next()
                  operation.abort.signal.throwIfAborted()
                  await this.writeStream({ type: 'body', id: frame.id,
                    data: this.binary ? next.value.subarray(offset, offset + BODY_CHUNK)
                      : Buffer.from(next.value.subarray(offset, offset + BODY_CHUNK)).toString('base64url') },
                  next.value.length <= 16 * 1024 ? 'control' : 'bulk')
                }
              }
            } finally { await reader.cancel(); reader.releaseLock() }
          }
          await this.send({ type: 'end', id: frame.id }, 'control')
        } else {
          if (frame.endpoint === 'mobile' || frame.endpoint.startsWith('mobile/')) throw new Error('mobile authorization is desktop-only')
          const stream = await this.ctx.typertGateway.wireStream.open(
            frame.endpoint, frame.payload, operation.inbox, this.peer, operation.abort.signal,
          )
          for await (const value of stream) {
            operation.abort.signal.throwIfAborted()
            const item = await compressedItem({ type: 'item', id: frame.id, value }, this.compressionMinBytes)
            operation.abort.signal.throwIfAborted()
            await this.writeStream(item, 'realtime')
          }
          operation.abort.signal.throwIfAborted()
          await this.send({ type: 'finish', id: frame.id }, 'realtime')
        }
      } catch (error) {
        if (!this.closed && !operation.abort.signal.aborted) {
          await this.send({ type: 'error', id: frame.id, failure: this.ctx.typertGateway.wireStream.failure(error) },
            frame.type === 'stream' ? 'realtime' : responseStarted ? 'bulk' : 'control')
        }
      } finally { operation.inbox.end(); operation.download.end(); operation.upload?.end(); this.operations.delete(frame.id) }
    })().catch((_error: unknown) => { this.close() })
  }

  /** Stop dependent work before the connection's authentication disappears. */
  close(): void {
    this.closed = true
    for (const operation of this.operations.values()) {
      operation.abort.abort(); operation.inbox.end(); operation.download.end(); operation.upload?.end()
    }
  }

  /** @returns after all dispatched work has observed cancellation. */
  async settled(): Promise<void> {
    this.close()
    await Promise.all([...this.operations.values()].map(operation => operation.task))
  }
}
