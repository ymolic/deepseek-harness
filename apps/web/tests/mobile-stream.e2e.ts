/** Recorded chat over the real mobile transport, including active-stream recovery. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, webkit, type Browser, type JSHandle, type Page, type WebSocketRoute } from 'playwright'
import { expect, it, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import {
  compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, type WebScaffold,
} from './scaffold.ts'
import { saveFailureShot } from './support.ts'

const relayRoot = process.env.DSH_MOBILE_RELAY_ROOT

interface RoutedSocket {
  client: WebSocketRoute
  server: WebSocketRoute
  hold: boolean
  held: number
  stalled: boolean
}

interface Bridge {
  fetch(input: string, init?: RequestInit): Promise<Response>
}

interface FollowObservation {
  snapshots: number
  restore(): void
}

async function foregroundCycle(page: Page, bfcacheOrder?: 'pageshow-first' | 'visibility-first'): Promise<void> {
  const lifecycle = await page.evaluateHandle(() => {
    const previous = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    return {
      hide(bfcache: boolean) {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
        document.dispatchEvent(new Event('visibilitychange'))
        if (bfcache) window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      },
      show(event: 'pageshow' | 'visibilitychange') {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
        if (event === 'pageshow') window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
        else document.dispatchEvent(new Event('visibilitychange'))
      },
      restore() {
        if (previous) Object.defineProperty(document, 'visibilityState', previous)
        else Reflect.deleteProperty(document, 'visibilityState')
      },
    }
  })
  try {
    await lifecycle.evaluate((events, bfcache) => { events.hide(bfcache) }, bfcacheOrder !== undefined)
    const first = bfcacheOrder === 'pageshow-first' ? 'pageshow' : 'visibilitychange'
    await lifecycle.evaluate((events, event: 'pageshow' | 'visibilitychange') => { events.show(event) }, first)
    if (bfcacheOrder !== undefined) {
      await lifecycle.evaluate((events, event: 'pageshow' | 'visibilitychange') => { events.show(event) },
        first === 'pageshow' ? 'visibilitychange' : 'pageshow')
      await lifecycle.evaluate((events) => { events.show('visibilitychange') })
    }
  } finally {
    try { await lifecycle.evaluate((events) => { events.restore() }) }
    finally { await lifecycle.dispose() }
  }
}

it.runIf(relayRoot).each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name streams live chat and restores it after foreground, phone and Host reconnects', async ({ engine, name }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-stream-'))
  let relay: { origin: string; close(): Promise<void> } | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let followObservation: JSHandle<FollowObservation> | undefined
  let failure: unknown
  let stage = 'boot'
  const pageErrors: string[] = []
  const sockets: RoutedSocket[] = []
  let restoreStreamObserver = () => {}
  let restoreRecoveryObservers = () => {}
  let hostHeads = 0
  const controlStreams: { baselines: number; updates: number; closed: boolean }[] = []
  const partials: string[] = []
  let mutations = 0
  const reached = Array.from({ length: 3 }, () => Promise.withResolvers<string>())
  const releases = Array.from({ length: 3 }, () => Promise.withResolvers<undefined>())
  try {
    const fixture: unknown = await import(pathToFileURL(join(relayRoot!, 'server/relay.mjs')).href)
    if (!isRecord(fixture) || typeof fixture.createRelay !== 'function') throw new Error('Relay fixture unavailable')
    const createRelay = fixture.createRelay as (options: {
      adminToken: string
      desktopToken: string
      origin: string
      stateFile: string
      staticDirectory: string
    }) => Promise<NonNullable<typeof relay>>
    const desktopToken = randomBytes(32).toString('base64url')
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile: join(root, 'devices.json'), staticDirectory: join(relayRoot!, 'public') })
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`)
    const replayFixture = await selectedSessionFixture(fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat/session.v3.jsonl', import.meta.url)))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture, compareReplaySession: false, paceMs: 0,
      replayProviders: [{ id: 'deepseek-messages', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
        contextWindow: 1000000, defaultMaxTokens: 256000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' }] }] })
    const modelCatalog = vi.spyOn(scaffold.ctx.sessionController, 'modelCatalog')
    const readResource = scaffold.ctx.webServer.readResource.bind(scaffold.ctx.webServer)
    const assets = vi.spyOn(scaffold.ctx.webServer, 'readResource').mockImplementation(async (request, peer) => {
      const response = await readResource(request, peer)
      if (request.method === 'HEAD') hostHeads++
      return response
    })
    restoreRecoveryObservers = () => { modelCatalog.mockRestore(); assets.mockRestore() }
    const wire = scaffold.ctx.typertGateway.wireStream
    const open = wire.open.bind(wire)
    const observer = vi.spyOn(wire, 'open').mockImplementation(async (...args) => {
      const source = await open(...args)
      if (args[0] !== 'session/control') return source
      const observation = { baselines: 0, updates: 0, closed: false }
      controlStreams.push(observation)
      return (async function* () {
        try {
          for await (const item of source) {
            if (isRecord(item) && item.type === 'baseline') observation.baselines++
            else observation.updates++
            yield item
          }
        } finally { observation.closed = true }
      })()
    })
    restoreStreamObserver = () => { observer.mockRestore() }
    scaffold.ctx.effect(() => scaffold!.ctx.connection.fetch.register({
      path: '/api/mobile-test.stream-mutate', methods: ['POST'], requestBody: 'buffered',
      fetch: (request) => {
        mutations++
        return new Promise<Response>((_resolve, reject) => {
          const abort = (): void => { reject(new Error('Synthetic mutation outcome unknown')) }
          if (request.signal.aborted) abort()
          else request.signal.addEventListener('abort', abort, { once: true })
        })
      },
    }), 'mobile stream: uncertain mutation')
    scaffold.ctx.on('llm/stream', async function* (_options, next) {
      let text = '', index = 0
      for await (const chunk of next()) {
        yield chunk
        if (chunk.type === 'text-delta' && index < reached.length) {
          text += chunk.text
          partials.push(text)
          reached[index]!.resolve(text)
          await releases[index++]!.promise
        }
      }
    }, { prepend: true })
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    const authorization = await scaffold.ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    const trustKey = credentialKey('mobile-controller', 'trusted-device')
    const trust = await scaffold.ctx.credentials.readRecord(trustKey)
    browser = await engine.launch(engine === chromium
      ? process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }
      : {})
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
    page.on('pageerror', error => pageErrors.push(error.message))
    page.on('crash', () => { console.info(`${name} mobile stream renderer crashed during ${stage}`) })
    const relaySocketOrigin = relay.origin.replace(/^http/, 'ws')
    const packetGzip = await page.evaluate(() => typeof DecompressionStream === 'function')
    const mobileSocket = `${relaySocketOrigin}/ws/mobile?packetMux=v1${packetGzip ? '&packetGzip=v1' : ''}`
    await page.routeWebSocket(url => url.origin === relaySocketOrigin && url.pathname === '/ws/mobile', (client) => {
      expect(client.url()).toBe(mobileSocket)
      const server = client.connectToServer()
      const socket = { client, server, hold: false, held: 0, stalled: false }
      sockets.push(socket)
      client.onMessage((message) => {
        if (socket.hold || socket.stalled) socket.held++
        else server.send(message)
      })
      server.onMessage((message) => { if (!socket.stalled) client.send(message) })
    })
    await page.goto(authorization.pairingUrl).catch(() => { throw new Error('Isolated phone navigation failed; URL omitted') })
    const client = page.frameLocator('iframe.full-frame')
    const editor = client.locator('[data-composer-input][contenteditable="true"]').first()
    await client.locator('[data-composer-input]').first().waitFor({ timeout: 90000 })
    await expect.poll(() => page!.locator('.full-diagnostic').textContent()).toContain(`binary/mux${packetGzip ? '/gzip' : ''}`)
    stage = 'workspace selection'
    await client.getByRole('textbox', { name: '选择工作区' }).click()
    const directory = client.getByRole('dialog', { name: '选择工作区目录' })
    await directory.getByRole('button', { name: '编辑路径' }).click()
    await directory.getByRole('textbox', { name: '编辑路径' }).fill(scaffold.workspaceCwd)
    await directory.getByRole('textbox', { name: '编辑路径' }).press('Enter')
    await directory.getByRole('button', { name: '打开', exact: true }).click()
    await editor.waitFor({ timeout: 30000 })
    const frame = await page.locator('iframe.full-frame').elementHandle()
    followObservation = await page.evaluateHandle(() => {
      const transport = Reflect.get(globalThis, '__DSH_MOBILE_BRIDGE__') as {
        openStream: (endpoint: string, payload: unknown, signal: AbortSignal,
          uplink?: AsyncIterable<unknown>) => AsyncIterable<unknown>
      }
      const openStream = transport.openStream
      const observation: FollowObservation = { snapshots: 0, restore() { transport.openStream = openStream } }
      transport.openStream = async function* (...args) {
        for await (const value of openStream(...args)) {
          yield value
          if (args[0] === 'session/follow' && value !== null && typeof value === 'object'
            && 'type' in value && value.type === 'snapshot') observation.snapshots++
        }
      }
      return observation
    })
    const initialSockets = sockets.length
    const prompts = fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
    const settled = scaffold.whenTurnSettled()
    void settled.catch(() => undefined)
    await editor.fill(prompts[0]!)
    await editor.press('Enter')
    stage = 'first live delta'
    const streaming = client.locator('[data-streaming="true"]')
    await expect.poll(() => partials.length, { timeout: 30000 }).toBe(1)
    await streaming.getByText(await reached[0]!.promise, { exact: true }).waitFor()
    await editor.fill('UNSENT_STREAM_RECOVERY_DRAFT')
    const selected = await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current'))

    expect(initialSockets).toBe(1)
    stage = 'healthy short foreground return'
    const modelRequests = modelCatalog.mock.calls.length
    const headsBeforeForeground = hostHeads
    expect(modelRequests).toBeGreaterThan(0)
    await expect.poll(() => controlStreams.at(-1)?.baselines).toBe(1)
    const previousControl = controlStreams.at(-1)!
    const followSnapshots = await followObservation.evaluate(value => value.snapshots)
    await foregroundCycle(page)
    await expect.poll(() => sockets.length, { timeout: 20000 }).toBe(initialSockets + 1)
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    await streaming.getByText(await reached[0]!.promise, { exact: true }).waitFor()
    await expect.poll(() => previousControl.closed).toBe(true)
    await expect.poll(() => controlStreams.at(-1) !== previousControl && controlStreams.at(-1)?.baselines === 1).toBe(true)
    await expect.poll(() => followObservation!.evaluate(value => value.snapshots), { timeout: 10000 }).toBeGreaterThan(followSnapshots)
    expect(hostHeads).toBe(headsBeforeForeground)
    expect(sockets).toHaveLength(initialSockets + 1)
    expect(await editor.innerText()).toBe('UNSENT_STREAM_RECOVERY_DRAFT')
    expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    const first = sockets.at(-1)!
    stage = 'pending mutation before acknowledgement hold'
    const uncertainMutation = page.evaluate(async () => {
      const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
      try { await bridge.fetch('/api/mobile-test.stream-mutate', { method: 'POST', body: '{"action":"once"}' }); return false }
      catch (error) { return error instanceof Error && error.message.includes('not retried') }
    })
    void uncertainMutation.catch(() => undefined)
    await expect.poll(() => mutations, { timeout: 10000 }).toBe(1)
    // Withhold all outbound ACKs: later deltas must arrive through the shared window before any are released.
    first.hold = true
    stage = 'withheld acknowledgement pipeline'
    for (let index = 1; index < reached.length; index++) {
      releases[index - 1]!.resolve(undefined)
      await expect.poll(() => partials.length, { timeout: 30000 }).toBe(index + 1)
      await streaming.getByText(await reached[index]!.promise, { exact: true }).waitFor({ timeout: 10000 })
    }
    await expect.poll(() => first.held).toBeGreaterThan(0)
    const partial = await reached[2]!.promise
    stage = 'stale OPEN foreground recovery'
    first.stalled = true
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    // Model lifecycle events with a stale OPEN transport; this does not suspend the browser process.
    await foregroundCycle(page)
    await expect.poll(() => sockets.length, { timeout: 20000 }).toBe(initialSockets + 2)
    expect(await uncertainMutation).toBe(true)
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    await streaming.getByText(partial, { exact: true }).waitFor()
    expect(mutations).toBe(1)
    expect(await editor.innerText()).toBe('UNSENT_STREAM_RECOVERY_DRAFT')
    expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    for (const order of ['pageshow-first', 'visibility-first'] as const) {
      stage = `BFCache recovery: ${order}`
      const beforeCycle = sockets.length
      const beforeControl = controlStreams.at(-1)!
      await foregroundCycle(page, order)
      await expect.poll(() => sockets.length, { timeout: 20000 }).toBe(beforeCycle + 1)
      await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
      await streaming.getByText(partial, { exact: true }).waitFor()
      await expect.poll(() => beforeControl.closed).toBe(true)
      await expect.poll(() => controlStreams.at(-1) !== beforeControl && controlStreams.at(-1)?.baselines === 1).toBe(true)
      expect(sockets).toHaveLength(beforeCycle + 1)
      expect(hostHeads).toBe(headsBeforeForeground)
      expect(mutations).toBe(1)
      expect(await editor.innerText()).toBe('UNSENT_STREAM_RECOVERY_DRAFT')
      expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    }
    expect(hostHeads).toBe(headsBeforeForeground)
    const foregroundSockets = sockets.length
    stage = 'phone socket recovery'
    const foreground = sockets.at(-1)!
    await Promise.all([foreground.client.close({ code: 1012 }), foreground.server.close({ code: 1012 })])
    await expect.poll(() => sockets.length, { timeout: 20000 }).toBe(foregroundSockets + 1)
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    await streaming.getByText(partial, { exact: true }).waitFor()
    expect(await editor.innerText()).toBe('UNSENT_STREAM_RECOVERY_DRAFT')

    const hostEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'mobile-controller')
    if (!hostEntry) throw new Error('Mobile controller Loader entry missing')
    const current = sockets.at(-1)!
    stage = 'Host recovery'
    current.hold = true
    const pending = page.evaluate(async () => {
      const bridge = Reflect.get(window, '__DSH_MOBILE_BRIDGE__') as Bridge
      try { await bridge.fetch('/api/session/modelCatalog', { method: 'POST', body: '{}' }); return false }
      catch (error) { return error instanceof Error && error.message.includes('not retried') }
    })
    void pending.catch(() => undefined)
    await expect.poll(() => current.held).toBeGreaterThan(0)
    await hostEntry.update({ disabled: true })
    await client.getByRole('button', { name: '远程连接: 已断开', exact: true }).waitFor()
    expect(await pending).toBe(true)
    current.hold = false
    await hostEntry.update({ disabled: false })
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    await streaming.getByText(partial, { exact: true }).waitFor()
    expect(sockets).toHaveLength(foregroundSockets + 1)
    expect(mutations).toBe(1)
    releases[2]!.resolve(undefined)
    stage = 'settlement'
    const sessionId = await settled
    await client.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    expect(await client.getByText('MESSAGES_WEB_READY', { exact: true }).count()).toBe(1)
    await expect.poll(() => streaming.count(), { timeout: 10000 }).toBe(0)
    expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    expect(await editor.innerText()).toBe('UNSENT_STREAM_RECOVERY_DRAFT')
    expect(await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current'))).toBe(selected)
    expect(await scaffold.ctx.credentials.readRecord(trustKey)).toEqual(trust)
    const session = scaffold.ctx.sessions.get(sessionId)!
    await compareOrRefreshGolden(fileURLToPath(new URL('../../../snapshots/web/mobile-remote/chat.expected.json', import.meta.url)),
      JSON.stringify(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' || event.type === 'assistant/message')
        .flatMap(event => event.type === 'user/message'
          ? [{ role: 'user', text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('') }]
          : event.type === 'assistant/message' ? [{ role: 'assistant', text: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') }] : []), null, 2), 'replay')
    stage = 'post-recovery model catalog'
    await client.getByRole('button', { name: /^选择模型/ }).click()
    await client.getByRole('menuitem', { name: /^模型/ }).click()
    const recoveredModel = client.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true })
    await recoveredModel.waitFor()
    await recoveredModel.click()
    stage = 'post-recovery subscription'
    await client.locator('[data-shell-leading]').getByRole('button', { name: '打开侧边栏', exact: true }).click()
    const drawer = client.getByRole('dialog', { name: '导航', exact: true })
    await drawer.locator('[data-row-key^="workspace:"]').first().waitFor()
    for (const group of await drawer.locator('[data-row-key^="workspace:"][aria-expanded="false"]').all()) await group.click()
    const row = drawer.locator(`[data-row-key="session:${sessionId}"]`)
    await row.waitFor()
    await scaffold.ctx.sessionController.rename({ sessionId, title: 'Recovered mobile session' })
    await row.getByText('Recovered mobile session', { exact: true }).waitFor()
    expect(pageErrors).toEqual([])
    await saveFailureShot(page, `mobile-stream-recovered-${name.toLowerCase()}`)
  } catch (error) {
    if (page) {
      console.info(JSON.stringify({ stage, pageErrors, phoneSockets: sockets.length,
        iframes: await page.locator('iframe.full-frame').count(), controlStreams,
        outer: await page.locator('body').innerText({ timeout: 1000 }).catch(() => 'unavailable'),
        inner: await page.frameLocator('iframe.full-frame').locator('body').innerText({ timeout: 1000 }).catch(() => 'unavailable'),
        sidebar: await page.frameLocator('iframe.full-frame').getByRole('dialog', { name: '导航', exact: true })
          .innerText({ timeout: 1000 }).catch(() => 'unavailable') }))
      await saveFailureShot(page, `mobile-stream-failed-${name.toLowerCase()}`)
    }
    failure = new Error(`${name} mobile stream failed during ${stage}`, { cause: error })
  }
  finally {
    restoreStreamObserver()
    restoreRecoveryObservers()
    for (const release of releases) release.resolve(undefined)
    for (const cleanup of [async () => {
      if (followObservation !== undefined) {
        try { await followObservation.evaluate((value) => { value.restore() }) }
        finally { await followObservation.dispose() }
      }
    }, async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop()).relayRevoked) throw new Error('Temporary trust revocation unconfirmed')
    }, () => browser?.close(), () => scaffold?.close(), () => relay?.close(), () => rm(root, { recursive: true, force: true })]) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Mobile stream test and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})
