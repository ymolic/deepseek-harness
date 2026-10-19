/** Manual, threshold-free transport comparison; uses no live trust, network or inference. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const candidate = process.env.DSH_MOBILE_RELAY_ROOT
const legacy = process.env.DSH_MOBILE_LEGACY_RELAY_ROOT
const diagnostic = process.env.DSH_MOBILE_PERF_DIAGNOSTIC === '1'
const artifacts = new URL('../../../.artifacts/', import.meta.url)

interface Relay {
  origin: string
  close(): Promise<void>
}

// Setup is excluded; the clock ends at the real composer's visibility. A fresh context is cold;
// a second page keeps IDB, SW and asset caches. The legacy relay is the encoding negative control.
async function sample(page: Page, url: string) {
  let incoming = 0, outgoing = 0, binaryFrames = 0
  const errors: string[] = []
  page.on('websocket', (socket) => {
    socket.on('framereceived', ({ payload }) => {
      incoming += Buffer.byteLength(payload)
      if (typeof payload !== 'string') binaryFrames++
    })
    socket.on('framesent', ({ payload }) => { outgoing += Buffer.byteLength(payload) })
  })
  page.on('pageerror', error => errors.push(error.message))
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Performance.enable')
  await cdp.send('HeapProfiler.collectGarbage')
  global.gc?.()
  const baseline = process.memoryUsage()
  let peakRSS = baseline.rss, peakHeap = 0
  const { metrics: before } = await cdp.send('Performance.getMetrics')
  const taskBefore = before.find(item => item.name === 'TaskDuration')?.value ?? 0
  let sampling: Promise<void> | undefined, samplingFailure: unknown
  const timer = setInterval(() => {
    peakRSS = Math.max(peakRSS, process.memoryUsage().rss)
    if (!sampling) sampling = cdp.send('Runtime.getHeapUsage').then((heap) => {
      peakHeap = Math.max(peakHeap, heap.usedSize)
    }).catch((error: unknown) => {
      samplingFailure = error
    }).finally(() => { sampling = undefined })
  }, 100)
  const progress = diagnostic ? setInterval(() => {
    void page.locator('.full-bar').textContent().then((status) => {
      console.info('MOBILE_PERF_PROGRESS', JSON.stringify({ incoming, outgoing, binaryFrames, status }))
    }).catch(() => undefined)
  }, 5000) : undefined
  const start = performance.now()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Isolated navigation failed; URL omitted') })
    await page.frameLocator('iframe.full-frame').locator('[data-composer-input]').first().waitFor({ timeout: 150000 })
    const readyMs = Math.round(performance.now() - start)
    const wire = { incoming, outgoing, binaryFrames }
    clearInterval(timer)
    clearInterval(progress)
    await sampling
    if (samplingFailure !== undefined) throw samplingFailure
    const { metrics } = await cdp.send('Performance.getMetrics')
    const heapAtReady = await cdp.send('Runtime.getHeapUsage')
    peakHeap = Math.max(peakHeap, heapAtReady.usedSize)
    const taskSeconds = (metrics.find(item => item.name === 'TaskDuration')?.value ?? 0) - taskBefore
    await cdp.send('HeapProfiler.collectGarbage')
    const retained = await cdp.send('Runtime.getHeapUsage')
    global.gc?.()
    const node = process.memoryUsage()
    const phases = await page.evaluate(() => Reflect.get(globalThis, '__mobilePerfPhases') as Record<string, number>)
    expect(errors).toEqual([])
    return { readyMs, wire, phases, browser: { taskSeconds, heapAtReady: heapAtReady.usedSize,
      retainedHeap: retained.usedSize, sampledPeakHeap: peakHeap },
    node: { baseline, retained: node, sampledPeakRSS: Math.max(peakRSS, node.rss) } }
  } catch (error) {
    const status = await page.locator('.full-bar').textContent().catch(() => 'unavailable')
    console.info('MOBILE_PERF_FAILED', JSON.stringify({ incoming, outgoing, binaryFrames, status, errors }))
    throw error
  } finally {
    clearInterval(timer)
    clearInterval(progress)
    await sampling
    await cdp.detach()
  }
}

it.runIf(candidate && legacy).each([
  { encoding: 'json', relayRoot: legacy },
  { encoding: 'binary', relayRoot: candidate },
])('measures $encoding cold/cache-hit startup with the same Host and Client build', async ({ encoding, relayRoot }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-perf-'))
  let relay: Relay | undefined, scaffold: WebScaffold | undefined, browser: Browser | undefined
  let failure: unknown
  try {
    const { createRelay } = await import(pathToFileURL(join(relayRoot!, 'server/relay.mjs')).href) as {
      createRelay: (options: { adminToken: string; desktopToken: string; origin: string; stateFile: string }) => Promise<Relay>
    }
    const desktopToken = randomBytes(32).toString('base64url')
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile: join(root, 'devices.json') })
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    browser = await chromium.launch(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' })
    const reports: object[] = []
    for (const limited of diagnostic ? [true] : [false, true]) {
      for (let run = 1; run <= (diagnostic ? 1 : 2); run++) {
        const authorization = await scaffold.ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
        const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
        const timers = new Set<ReturnType<typeof setTimeout>>()
        const closing = new Set<Promise<void>>()
        const networkFailure = Promise.withResolvers<never>()
        void networkFailure.promise.catch(() => undefined)
        let activeSample: ReturnType<typeof sample> | undefined
        let closed = false
        try {
          await context.addInitScript(() => {
            const phases: Record<string, number> = {}
            Reflect.set(globalThis, '__mobilePerfPhases', phases)
            new MutationObserver(() => {
              const content = document.querySelector<HTMLElement>('.full-content')
              if (document.querySelector('iframe.full-frame')) phases.iframe ??= Math.round(performance.now())
              if (content?.dataset.state === 'ready') phases.mounted ??= Math.round(performance.now())
            }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] })
          })
          if (limited) await context.routeWebSocket('**/ws/mobile', (route) => {
            const server = route.connectToServer()
            const sender = (send: (message: string | Buffer) => void) => {
              let available = performance.now()
              let scheduled = 0, delivered = 0
              let stopped = false
              let timer: ReturnType<typeof setTimeout> | undefined
              const queued: { message: string | Buffer; at: number; index: number }[] = []
              const schedule = () => {
                if (closed || stopped || timer || !queued.length) return
                timer = setTimeout(() => {
                  timers.delete(timer!)
                  timer = undefined
                  while (!closed && queued[0] && queued[0].at <= performance.now()) {
                    const next = queued.shift()!
                    if (next.index !== delivered++) {
                      networkFailure.reject(new Error('Network limiter reordered WebSocket messages'))
                      return
                    }
                    try { send(next.message) }
                    catch (error) { networkFailure.reject(error); return }
                  }
                  schedule()
                }, Math.max(0, queued[0]!.at - performance.now()))
                timers.add(timer)
              }
              return { send(message: string | Buffer) {
                if (stopped) return
                const now = performance.now()
                available = Math.max(available, now) + Buffer.byteLength(message) / 250000 * 1000
                queued.push({ message, at: available + 225, index: scheduled++ })
                schedule()
              }, close() {
                stopped = true
                if (timer) { clearTimeout(timer); timers.delete(timer); timer = undefined }
                queued.length = 0
              } }
            }
            // One timer drains each FIFO; independent timers can reorder tiny ACKs on Windows.
            const up = sender((message) => { server.send(message) }), down = sender((message) => { route.send(message) })
            const close = (task: Promise<void>) => {
              up.close(); down.close()
              const handled = task.catch((error: unknown) => { if (!closed) networkFailure.reject(error) })
              closing.add(handled)
              void handled.finally(() => closing.delete(handled))
            }
            route.onMessage((message) => { up.send(message) })
            server.onMessage((message) => { down.send(message) })
            route.onClose((code, reason) => { close(server.close({
              ...code === undefined ? {} : { code }, ...reason === undefined ? {} : { reason },
            })) })
            server.onClose((code, reason) => { close(route.close({
              ...code === undefined ? {} : { code }, ...reason === undefined ? {} : { reason },
            })) })
          })
          const page = await context.newPage()
          activeSample = sample(page, authorization.pairingUrl)
          const cold = await Promise.race([activeSample, networkFailure.promise])
          expect(cold.wire.binaryFrames > 0).toBe(encoding === 'binary')
          reports.push({ run, limited, kind: 'cold', ...cold })
          console.info('MOBILE_PERF', JSON.stringify({ encoding, run, limited, kind: 'cold', ...cold }))
          await expect.poll(() => page.evaluate(async () => {
            const name = (await caches.keys()).find(value => value.startsWith('dsh-mobile-assets-'))
            return name ? (await (await caches.open(name)).keys()).length : 0
          })).toBeGreaterThan(0)
          await page.close()
          activeSample = sample(await context.newPage(), relay.origin)
          const refresh = await Promise.race([activeSample, networkFailure.promise])
          reports.push({ run, limited, kind: 'refresh', ...refresh })
          console.info('MOBILE_PERF', JSON.stringify({ encoding, run, limited, kind: 'refresh', ...refresh }))
        } finally {
          closed = true
          for (const timer of timers) clearTimeout(timer)
          await context.close()
          await Promise.all(closing)
          await activeSample?.catch(() => undefined)
        }
        expect((await scaffold.ctx.mobileController.stop()).relayRevoked).toBe(true)
      }
    }
    await mkdir(artifacts, { recursive: true })
    await writeFile(new URL(`mobile-transport-${encoding}${diagnostic ? '-diagnostic' : ''}.json`, artifacts), JSON.stringify({
      measuredAt: new Date().toISOString(), node: process.version, platform: process.platform, engine: browser.version(),
      limits: 'loopback or 450ms extra RTT and 250000 B/s per direction; WS application bytes, excluding WS/TLS overhead',
      memory: 'live page at readiness; browser top-target heap and Node driver/Loader/relay memory; forced GC retained, 100ms sampled peaks; not total browser RSS',
      reports,
    }, null, 2) + '\n')
  } catch (error) { failure = error }
  finally {
    for (const cleanup of [async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop()).relayRevoked) throw new Error('Temporary trust revocation unconfirmed')
    }, () => browser?.close(), () => scaffold?.close(), () => relay?.close(), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Measurement cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})
