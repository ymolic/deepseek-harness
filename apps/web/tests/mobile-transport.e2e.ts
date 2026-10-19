/** Real Loader/relay/browser transport, including optional frozen legacy checkouts. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, webkit, type Browser } from 'playwright'
import { expect, it } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import { isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

const relayRoot = process.env.DSH_MOBILE_RELAY_ROOT
const legacyRelay = process.env.DSH_MOBILE_LEGACY_RELAY_ROOT
const legacyHost = process.env.DSH_MOBILE_LEGACY_HOST_ROOT

interface Bridge {
  fetch(input: string, init?: RequestInit): Promise<Response>
  connectionControls(source: Window): { reconnect(): void }
}

const cases = [
  { name: 'Chromium binary', engine: chromium, binary: true },
  { name: 'WebKit binary', engine: webkit, binary: true },
  ...legacyRelay && legacyHost ? [
    { name: 'old relay, new Host and page', engine: chromium, binary: false, oldRelay: true },
    { name: 'old Host, new relay and page', engine: chromium, binary: false, oldHost: true },
    { name: 'old page, new relay and Host', engine: chromium, binary: false, oldPage: true },
    { name: 'relay rollback with an open binary page', engine: chromium, binary: true, rollback: true },
  ] : [],
]

it.runIf(relayRoot).each(cases)('$name retains exact bytes, cache, cancellation and uncertain-write non-replay', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-transport-'))
  let relay: { origin: string; close(): Promise<void> } | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let failure: unknown
  try {
    const oldRelay = 'oldRelay' in scenario && scenario.oldRelay
    const oldHost = 'oldHost' in scenario && scenario.oldHost
    const oldPage = 'oldPage' in scenario && scenario.oldPage
    const rollback = 'rollback' in scenario && scenario.rollback
    const serverRoot = oldRelay ? legacyRelay! : relayRoot!
    const staticDirectory = join(oldPage ? legacyRelay! : relayRoot!, 'public')
    if (oldRelay || oldPage || rollback) {
      const manifest: unknown = JSON.parse(await readFile(join(legacyRelay!, 'package.json'), 'utf8'))
      expect(manifest).toMatchObject({ version: '0.3.8' })
    }
    if (oldHost) expect(await readFile(join(legacyHost!, 'packages/api/mobile-controller/lib/index.js'), 'utf8')).not.toContain('sealBinary')
    const fixture: unknown = await import(pathToFileURL(join(serverRoot, 'server/relay.mjs')).href)
    if (!isRecord(fixture) || typeof fixture.createRelay !== 'function') throw new Error('Relay fixture unavailable')
    const createRelay = fixture.createRelay as (options: {
      adminToken: string
      desktopToken: string
      origin: string
      stateFile: string
      staticDirectory: string
      port?: number
    }) => Promise<NonNullable<typeof relay>>
    const desktopToken = randomBytes(32).toString('base64url')
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile: join(root, 'devices.json'), staticDirectory })
    const overlay = join(root, 'mobile.yml')
    // Overlay names assert the existing module; replacing it requires a separate entry.
    const entry = oldHost
      ? `- id: mobile-controller\n  disabled: true\n- insert:\n    - id: mobile-controller-legacy\n      name: ${pathToFileURL(join(legacyHost!, 'packages/api/mobile-controller/lib/index.js')).href}\n      config:\n        enabled: true\n        relayOrigin: ${relay.origin}\n`
      : `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`
    await writeFile(overlay, entry)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const size = 9 * 1024 * 1024 + 17
    const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
    let cancelled = false, mutations = 0
    const entered = Promise.withResolvers<undefined>()
    scaffold.ctx.effect(() => scaffold!.ctx.connection.fetch.register({
      path: '/api/mobile-test.transfer', methods: ['GET', 'POST'], requestBody: 'streaming',
      fetch: async (request) => {
        if (request.method !== 'POST') return new Response(bytes)
        const uploaded = new Uint8Array(await request.arrayBuffer())
        return Response.json({ size: uploaded.length, exact: uploaded.every((byte, index) => byte === index % 251) })
      },
    }), 'transport test: exact bytes')
    scaffold.ctx.effect(() => scaffold!.ctx.connection.fetch.register({
      path: '/api/mobile-test.cancel', methods: ['GET'], requestBody: 'buffered',
      fetch: async (request) => {
        request.signal.addEventListener('abort', () => { cancelled = true }, { once: true })
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { controller.enqueue(new Uint8Array(192 * 1024)) },
        }))
      },
    }), 'transport test: cancellation')
    scaffold.ctx.effect(() => scaffold!.ctx.connection.fetch.register({
      path: '/api/mobile-test.mutate', methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => {
        mutations++; entered.resolve(undefined)
        return new Promise<Response>((_resolve, reject) => {
          const abort = () => { reject(new Error('Synthetic mutation outcome unknown')) }
          if (request.signal.aborted) abort()
          else request.signal.addEventListener('abort', abort, { once: true })
        })
      },
    }), 'transport test: uncertain mutation')
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    const authorization = await scaffold.ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    browser = await scenario.engine.launch(scenario.engine === chromium
      ? process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }
      : {})
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
    if (oldRelay) await page.route('**/binary.js', async (route) => {
      await route.fulfill({ contentType: 'text/javascript', body: await readFile(join(relayRoot!, 'public/binary.js'), 'utf8') })
    })
    const errors: string[] = [], binaryFrames: number[] = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', socket => socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') binaryFrames.push(payload.length)
    }))
    await page.goto(authorization.pairingUrl).catch(() => { throw new Error('Isolated navigation failed; URL omitted') })
    const client = page.frameLocator('iframe.full-frame')
    await client.locator('[data-composer-input]').first().waitFor({ timeout: 90000 })
    expect(binaryFrames.length > 0).toBe(scenario.binary)
    const transfer = await page.evaluate(async (size) => {
      const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
      const uploaded = await (await bridge.fetch('/api/mobile-test.transfer', { method: 'POST', body: bytes })).json() as { size: number; exact: boolean }
      const downloaded = new Uint8Array(await (await bridge.fetch('/api/mobile-test.transfer')).arrayBuffer())
      return { uploaded, size: downloaded.length, exact: downloaded.every((byte, index) => byte === index % 251) }
    }, size)
    expect(transfer).toEqual({ uploaded: { size, exact: true }, size, exact: true })
    await page.evaluate(async () => {
      const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
      const response = await bridge.fetch('/api/mobile-test.cancel')
      const reader = response.body!.getReader()
      await reader.read(); await reader.cancel()
    })
    await expect.poll(() => cancelled).toBe(true)
    const uncertain = page.evaluate(async () => {
      const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
      try { await bridge.fetch('/api/mobile-test.mutate', { method: 'POST' }); return false }
      catch (error) { return error instanceof Error && error.message.includes('not retried') }
    })
    void uncertain.catch(() => undefined)
    await entered.promise
    const precedingFrames = binaryFrames.length
    if (rollback) {
      const origin = relay.origin
      await relay.close()
      const old: unknown = await import(pathToFileURL(join(legacyRelay!, 'server/relay.mjs')).href)
      if (!isRecord(old) || typeof old.createRelay !== 'function') throw new Error('Legacy relay fixture unavailable')
      const restart = old.createRelay as typeof createRelay
      relay = await restart({ adminToken: randomBytes(32).toString('base64url'), desktopToken, origin, port: Number(new URL(origin).port),
        stateFile: join(root, 'devices.json'), staticDirectory: join(legacyRelay!, 'public') })
    } else {
      await page.evaluate(() => {
        const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
        bridge.connectionControls(document.querySelector('iframe')!.contentWindow!).reconnect()
      })
    }
    expect(await uncertain).toBe(true)
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    expect(mutations).toBe(1)
    const cachedBefore = await page.evaluate(async () => {
      const name = (await caches.keys()).find(name => name.startsWith('dsh-mobile-assets-'))
      return name ? (await (await caches.open(name)).keys()).length : 0
    })
    expect(cachedBefore).toBeGreaterThan(0)
    await page.reload()
    await client.locator('[data-composer-input]').first().waitFor({ timeout: 90000 })
    expect(mutations).toBe(1)
    expect(binaryFrames.length > precedingFrames).toBe(scenario.binary && !rollback)
    if (scenario.binary) expect(Math.max(...binaryFrames)).toBeLessThanOrEqual(12073)
    expect(errors).toEqual([])
  } catch (error) { failure = error }
  finally {
    for (const cleanup of [async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop()).relayRevoked) throw new Error('Temporary trust revocation unconfirmed')
    }, () => browser?.close(), () => scaffold?.close(), () => relay?.close(), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Transport test and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})
