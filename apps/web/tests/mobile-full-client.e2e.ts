/** Full-client requests against the shipped Loader and registered application services. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, webkit, type Browser, type Page } from 'playwright'
import { expect, it, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type { ClientModuleLoaderTarget } from '@deepseek-ai/dsh-client-modules/client'
import { isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import { mobileRelayFixture } from './mobile-relay-fixture.ts'
import { saveFailureShot } from './support.ts'
import { compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'

it('pairs without a Session, loads the full application, dispatches real RPC and keeps trust on unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-full-mobile-'))
  const relay = await mobileRelayFixture()
  let scaffold: WebScaffold | undefined
  try {
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    await ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), relay.desktopToken)
    const authorization = await ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    expect(authorization.state.sessionId).toBeNull()
    expect(authorization.state.expiresAt).toBeNull()
    const phone = relay.pairFull(authorization.pairingUrl)
    await phone.ready
    expect(ctx.mobileController.status().pairingUrl).toBeUndefined()
    await phone.send({ type: 'fetch', id: 'application-html-0001', url: '/', method: 'GET', headers: {} })
    await expect.poll(() => phone.replies.some(frame => isRecord(frame) && frame.type === 'end')).toBe(true)
    const html = phone.replies.filter(isRecord).filter(frame => frame.type === 'body').map(frame => Buffer.from(String(frame.data), 'base64url').toString()).join('')
    expect(html).toContain('__DSH_BOOT__')
    expect(html).toContain('assets/')
    await phone.send({ type: 'fetch', id: 'invalid-origin-0001', url: 'https://untrusted.invalid/', method: 'GET', headers: {} })
    await expect.poll(() => phone.replies.some(frame => isRecord(frame) && frame.id === 'invalid-origin-0001' && frame.type === 'error')).toBe(true)
    await phone.send({ type: 'fetch', id: 'workspace-list-0001', url: '/api/session/modelCatalog', method: 'POST',
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({
        type: 'client-request', rpcId: 'mobile-workspaces', method: 'session/modelCatalog', payload: { args: {} },
      })).toString('base64url') })
    await expect.poll(() => phone.replies.some(frame => isRecord(frame) && frame.id === 'workspace-list-0001' && frame.type === 'end')).toBe(true)
    const result = phone.replies.filter(isRecord).filter(frame => frame.id === 'workspace-list-0001' && frame.type === 'body')
      .map(frame => Buffer.from(String(frame.data), 'base64url').toString()).join('')
    const reply: unknown = JSON.parse(result)
    expect(isRecord(reply) && isRecord(reply.result) && reply.result.ok, result).toBe(true)
    await phone.send({ type: 'stream', id: 'workspace-feed-0001', endpoint: 'workspace/follow', payload: { args: {} } })
    await expect.poll(() => phone.replies.some(frame => isRecord(frame) && frame.id === 'workspace-feed-0001' && frame.type === 'item')).toBe(true)
    await phone.send({ type: 'cancel', id: 'workspace-feed-0001' })
    expect(phone.errors).toEqual([])
    const key = credentialKey('mobile-controller', 'trusted-device')
    expect((await ctx.credentials.readRecord(key))?.kind).toBe('grant')
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'mobile-controller')
    phone.detach()
    await entry?.update({ disabled: true })
    expect(relay.activeRooms).toBe(1)
    expect((await ctx.credentials.readRecord(key))?.kind).toBe('grant')
    await entry?.update({ disabled: false })
    await expect.poll(() => ctx.get('mobileController')?.status().scope).toBe('instance')
    relay.revocation(false)
    await expect(ctx.mobileController.stop()).rejects.toThrow()
    expect(ctx.mobileController.status().relayRevoked).toBe(false)
    const tombstone = await ctx.credentials.readRecord(key)
    expect(tombstone?.kind === 'grant' ? tombstone.payload : undefined).toMatchObject({ revoked: true })
    await entry?.update({ disabled: true })
    await entry?.update({ disabled: false })
    await expect.poll(() => ctx.get('mobileController')?.status().phase).toBe('stopped')
    relay.revocation(true)
    expect((await ctx.mobileController.stop()).relayRevoked).toBe(true)
    expect(relay.activeRooms).toBe(0)
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
    await ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    const barrier = relay.holdNextRevocation()
    const replacing = expect(ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })).rejects.toThrow()
    await barrier.entered
    const stopping = ctx.mobileController.stop()
    barrier.release()
    await replacing
    expect((await stopping).relayRevoked).toBe(true)
    expect(relay.created).toBe(2)
    expect(relay.activeRooms).toBe(0)
    await ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    const failedWrite = vi.spyOn(ctx.credentials, 'modifyRecord').mockRejectedValueOnce(new Error('fixture storage unavailable'))
    try { expect((await ctx.mobileController.stop()).relayRevoked).toBe(true) }
    finally { failedWrite.mockRestore() }
    expect(relay.activeRooms).toBe(0)
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
    await entry?.update({ disabled: true })
    await ctx.credentials.modifyRecord(key, () => Promise.resolve({ kind: 'grant', payload: { version: 'invalid' } }))
    await entry?.update({ disabled: false })
    await expect.poll(() => ctx.get('mobileController')?.status().phase).toBe('failed')
    expect((await ctx.mobileController.stop()).relayRevoked).toBe(false)
    expect(await ctx.credentials.readRecord(key)).toBeUndefined()
  } finally {
    try { await scaffold?.close() }
    finally { await relay.close(); await rm(root, { recursive: true, force: true }) }
  }
}, 60000)

// The deployable relay lives in the operator's infrastructure repository, not this package.
// Setting its root opts into the real distributor/worker/browser acceptance path.
const relayRoot = process.env.DSH_MOBILE_RELAY_ROOT

interface PhoneClientObservation {
  toggle?: (disabled: boolean) => Promise<void>
}

async function observePhoneClient(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const observation: PhoneClientObservation = {}
    Reflect.set(globalThis, '__phoneClientTest', observation)
    Object.defineProperty(globalThis, '__ModuleLoader__', {
      configurable: true,
      set(target: ClientModuleLoaderTarget) {
        Object.defineProperty(globalThis, '__ModuleLoader__', { configurable: true, writable: true, value: target })
        let load = target.load.bind(target)
        const observe: ClientModuleLoaderTarget['load'] = (registration) => {
          if (registration.id !== '@deepseek-ai/dsh-client-ui-mobile-remote' || registration.chunk !== undefined) {
            load(registration)
            return
          }
          load({ ...registration, factory(require) {
            const exports = registration.factory(require)
            type Entry = { options: { name?: string }; update(config: { disabled: boolean }): Promise<unknown> }
            type ClientContext = { loader: { entries(): Iterable<Entry> } }
            const apply = exports.apply as (ctx: ClientContext, config: unknown) => unknown
            return { ...exports, apply(ctx: ClientContext, config: unknown) {
              const result = apply(ctx, config)
              observation.toggle = async (disabled) => {
                const entry = [...ctx.loader.entries()].find(value => value.options.name === '@deepseek-ai/dsh-client-ui-mobile-remote')
                if (!entry) throw new Error('Phone UI Loader entry missing')
                await entry.update({ disabled })
              }
              return result
            } }
          } })
        }
        Object.defineProperty(target, 'load', {
          configurable: true, get: () => observe,
          set(next: ClientModuleLoaderTarget['load']) { load = next.bind(target) },
        })
      },
    })
  })
}

it.runIf(relayRoot).each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name clears an early startup failure and hands off connection controls with real Loader cleanup', async ({ engine, name }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-phone-startup-recovery-'))
  let relay: { origin: string; close(): Promise<void> } | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let failure: unknown
  try {
    const fixture: unknown = await import(pathToFileURL(join(relayRoot!, 'server/relay.mjs')).href)
    if (!isRecord(fixture) || typeof fixture.createRelay !== 'function') throw new Error('relay fixture unavailable')
    const createRelay = fixture.createRelay as (options: {
      adminToken: string
      desktopToken: string
      origin: string
      stateFile: string
      staticDirectory: string
    }) => Promise<NonNullable<typeof relay>>
    const desktopToken = randomBytes(32).toString('base64url')
    const staticDirectory = join(root, 'public')
    await cp(join(relayRoot!, 'public'), staticDirectory, { recursive: true })
    const bridgePath = join(staticDirectory, 'full-client.js')
    await writeFile(bridgePath, `${await readFile(bridgePath, 'utf8')}
dispatchEvent(new Event('unhandledrejection'));
parent.document.documentElement.dataset.testStartupFailure = parent.document.querySelector('.full-content').dataset.state;
`)
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile: join(root, 'devices.json'), staticDirectory })
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    const authorization = await scaffold.ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    const trust = await scaffold.ctx.credentials.readRecord(credentialKey('mobile-controller', 'trusted-device'))
    browser = await engine.launch(engine === chromium
      ? process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }
      : {})
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true,
    })
    const page = await context.newPage()
    await observePhoneClient(page)
    const errors: string[] = []
    let connections = 0
    page.on('pageerror', error => errors.push(error.message))
    page.on('websocket', () => { connections++ })
    await page.goto(authorization.pairingUrl, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Phone navigation failed') })
    await page.frameLocator('iframe.full-frame').locator('[data-composer-input]').first().waitFor({ timeout: 90000 })
    expect(await page.locator('html').getAttribute('data-test-startup-failure')).toBe('failed')
    await page.locator('.full-content[data-state="ready"]').waitFor()
    expect(await page.locator('iframe.full-frame').count()).toBe(1)
    expect(await page.locator('.full-loading').isVisible()).toBe(false)
    expect(await page.locator('.full-bar [role="status"]').textContent()).toBe('已连接')
    expect(connections).toBe(1)
    expect(await scaffold.ctx.credentials.readRecord(credentialKey('mobile-controller', 'trusted-device'))).toEqual(trust)
    const client = page.frameLocator('iframe.full-frame')
    const button = client.getByRole('button', { name: '远程连接: 已连接', exact: true })
    await button.waitFor()
    await expect.poll(() => page.locator('.full-bar').isVisible()).toBe(false)
    const frame = await page.locator('iframe.full-frame').elementHandle()
    await client.getByRole('textbox', { name: '选择工作区' }).click()
    const directory = client.getByRole('dialog', { name: '选择工作区目录' })
    await directory.getByRole('button', { name: '编辑路径' }).click()
    await directory.getByRole('textbox', { name: '编辑路径' }).fill(scaffold.workspaceCwd)
    await directory.getByRole('textbox', { name: '编辑路径' }).press('Enter')
    await directory.getByRole('button', { name: '打开', exact: true }).click()
    await client.locator('[data-composer-input][contenteditable="true"]').waitFor()
    const editor = client.locator('[data-composer-input]').first()
    await editor.fill('UNSENT_CONNECTION_DRAFT')
    const toggle = async (disabled: boolean) => {
      await client.locator('body').evaluate(async (_element, disabled) => {
        await (Reflect.get(globalThis, '__phoneClientTest') as PhoneClientObservation).toggle!(disabled)
      }, disabled)
    }
    // Disable the actual Loader entry: a new relay with no usable inner entry keeps its old controls.
    await toggle(true)
    await expect.poll(() => page.locator('.full-bar').isVisible()).toBe(true)
    const fallbackHeight = await page.locator('.full-bar').evaluate(element => element.getBoundingClientRect().height)
    const fallbackFrameHeight = await page.locator('iframe.full-frame').evaluate(element => element.getBoundingClientRect().height)
    expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    await toggle(false)
    await button.waitFor()
    await expect.poll(() => page.locator('.full-bar').evaluate(element => element.getBoundingClientRect().height)).toBe(0)
    const fullHeight = await page.locator('iframe.full-frame').evaluate(element => element.getBoundingClientRect().height)
    expect(fullHeight - fallbackFrameHeight).toBe(fallbackHeight)
    console.info(`${name} connection header reclaimed: ${fallbackHeight} CSS px`)
    expect(await editor.innerText()).toContain('UNSENT_CONNECTION_DRAFT')
    const panel = client.getByRole('dialog', { name: '远程连接', exact: true })
    for (const width of [390, 320]) {
      for (const theme of ['light', 'dark'] as const) {
        await page.setViewportSize({ width, height: 844 })
        await page.emulateMedia({ colorScheme: theme })
        await expect.poll(() => client.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
        await button.click()
        await panel.waitFor()
        expect(await panel.evaluate(element => element.contains(document.activeElement))).toBe(true)
        expect(await button.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44)
        expect(await client.locator('[data-shell-leading]').evaluate(element => element.getBoundingClientRect().height)).toBe(44)
        expect(await panel.evaluate((element) => {
          const rect = element.getBoundingClientRect()
          return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight
            && document.documentElement.scrollWidth === innerWidth
        })).toBe(true)
        await panel.evaluate(async (element) => {
          await Promise.all(element.parentElement!.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map(animation => animation.finished))
        })
        await saveFailureShot(page, `mobile-connection-${name.toLowerCase()}-${width}-${theme}`)
        await panel.getByRole('button', { name: '忘记此设备…', exact: true }).click()
        const confirmation = client.getByRole('dialog', { name: '忘记此设备？', exact: true })
        await confirmation.getByText(/之后需要在桌面重新生成二维码并扫码连接/).waitFor()
        await confirmation.getByRole('button', { name: '取消', exact: true }).click()
        expect(connections).toBe(1)
        expect(await scaffold.ctx.credentials.readRecord(credentialKey('mobile-controller', 'trusted-device'))).toEqual(trust)
        await page.keyboard.press('Escape')
        await panel.waitFor({ state: 'hidden' })
        expect(await button.evaluate(element => element === document.activeElement)).toBe(true)
      }
    }
    await page.setViewportSize({ width: 844, height: 390 })
    await page.locator('.full-bar').waitFor()
    await page.setViewportSize({ width: 390, height: 430 })
    await button.waitFor()
    await expect.poll(() => page.locator('.full-bar').isVisible()).toBe(false)
    expect(await editor.innerText()).toContain('UNSENT_CONNECTION_DRAFT')
    await button.click()
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await button.click()
    // The shared mask intercepts a background click without focusing the editor.
    await client.locator('[role="presentation"]').last().click({ position: { x: 5, y: 5 } })
    await panel.waitFor({ state: 'hidden' })
    expect(await button.evaluate(element => element === document.activeElement)).toBe(true)
    await button.click()
    await panel.getByRole('button', { name: '重新连接', exact: true }).click()
    await expect.poll(() => connections).toBe(2)
    await button.waitFor()
    expect(await page.locator('iframe.full-frame').evaluate((element, previous) => element === previous, frame)).toBe(true)
    expect(await editor.innerText()).toContain('UNSENT_CONNECTION_DRAFT')
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    await button.click()
    await panel.locator('p').last().evaluate((element) => { element.textContent = 'SYNTHETIC_CONNECTION_REASON_'.repeat(160) })
    expect(await panel.evaluate((element) => {
      const body = element.lastElementChild!
      const rect = element.getBoundingClientRect()
      return body.scrollHeight > body.clientHeight && rect.top >= 0 && rect.bottom <= innerHeight
    })).toBe(true)
    await panel.getByRole('button', { name: '关闭', exact: true }).click()
    const replacement = await page.context().newPage()
    try {
      await replacement.goto(relay.origin)
      await replacement.frameLocator('iframe.full-frame').getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor({ timeout: 90000 })
      await client.getByRole('button', { name: '远程连接: 已在其他页面打开', exact: true }).waitFor()
      await client.getByRole('button', { name: '远程连接: 已在其他页面打开', exact: true }).click()
      expect(await panel.getByRole('button', { name: '重新连接' }).count()).toBe(0)
      expect(await panel.getByText(/本页不会争抢重连/).isVisible()).toBe(true)
      expect(connections).toBe(2)
      await panel.getByRole('button', { name: '关闭', exact: true }).click()
    } finally { await replacement.close() }
    await page.route('**/forget', route => route.fulfill({ status: 503, body: '' }))
    await client.getByRole('button', { name: '远程连接: 已在其他页面打开', exact: true }).click()
    await panel.getByRole('button', { name: '忘记此设备…', exact: true }).click()
    await client.getByRole('dialog', { name: '忘记此设备？' }).getByRole('button', { name: '撤销设备信任' }).click()
    await client.getByRole('button', { name: '远程连接: 撤销未确认', exact: true }).waitFor()
    expect(await panel.getByRole('button', { name: '重新连接' }).count()).toBe(0)
    expect(await panel.getByText(/服务器尚未确认撤销/).isVisible()).toBe(true)
    expect(await page.locator('.full-bar').isVisible()).toBe(false)
    await page.unroute('**/forget')
    await panel.getByRole('button', { name: '忘记此设备…', exact: true }).click()
    await client.getByRole('dialog', { name: '忘记此设备？' }).getByRole('button', { name: '撤销设备信任' }).click()
    await page.locator('.full-bar').getByText('请在桌面重新生成二维码并扫码', { exact: true }).waitFor()
    expect(await page.locator('iframe.full-frame').count()).toBe(0)
    expect(errors).toEqual([])
  } catch (error) { failure = error }
  finally {
    const cleanups = [async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop()).relayRevoked) throw new Error('Temporary trust revocation unconfirmed')
    }, () => browser?.close(), () => scaffold?.close(), () => relay?.close(),
    () => rm(root, { recursive: true, force: true })]
    for (const cleanup of cleanups) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Phone startup recovery and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})

it.runIf(relayRoot).each([
  { name: 'Chromium', engine: chromium },
  { name: 'WebKit', engine: webkit },
])('$name boots the complete phone client through the deployable relay and replays a recorded conversation', async ({ engine, name }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-full-phone-'))
  let relay: { origin: string; close(): Promise<void> } | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let failure: unknown
  try {
    // The optional infrastructure fixture is an ESM module outside this TypeScript program.
    const fixture: unknown = await import(pathToFileURL(join(relayRoot!, 'server/relay.mjs')).href)
    if (!isRecord(fixture) || typeof fixture.createRelay !== 'function') throw new Error('relay fixture unavailable')
    const createRelay = fixture.createRelay as (options: {
      adminToken: string
      desktopToken: string
      origin: string
      stateFile: string
      staticDirectory: string
    }) => Promise<NonNullable<typeof relay>>
    const desktopToken = randomBytes(32).toString('base64url')
    const staticDirectory = join(root, 'public')
    await cp(join(relayRoot!, 'public'), staticDirectory, { recursive: true })
    const workerPath = join(staticDirectory, 'sw.js')
    const workerSource = await readFile(workerPath, 'utf8')
    await writeFile(workerPath, "self.addEventListener('install', event => event.waitUntil(Promise.reject(new Error('Fixture worker installation unavailable'))));\n")
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile: join(root, 'devices.json'), staticDirectory })
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n`)
    const replayFixture = await selectedSessionFixture(fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat/session.v3.jsonl', import.meta.url)), false)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture, compareReplaySession: false, paceMs: 5,
      replayProviders: [{ id: 'deepseek-messages', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
        contextWindow: 1000000, defaultMaxTokens: 256000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' },
      ...Array.from({ length: 4 }, (_, index) => ({ id: `phone-search-${index}`, name: `Phone Search ${index}` }))] }] })
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'deepseek-messages', model: 'deepseek-v4-flash' })
    const transferSize = 9 * 1024 * 1024 + 17
    const transferBytes = Uint8Array.from({ length: transferSize }, (_, index) => index % 251)
    scaffold.ctx.effect(() => scaffold!.ctx.connection.fetch.register({
      path: '/api/mobile-test.transfer', methods: ['GET', 'POST'], requestBody: 'streaming',
      fetch: async request => request.method === 'POST'
        ? Response.json({ size: (await request.arrayBuffer()).byteLength })
        : new Response(transferBytes, { headers: { 'content-type': 'application/octet-stream' } }),
    }), 'mobile acceptance: binary transfer route')
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    const authorization = await scaffold.ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    browser = await engine.launch(engine === chromium
      ? process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chrome' }
      : {})
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    })
    await page.addInitScript(() => {
      const requests: string[] = []
      Object.assign(window, { __DSH_TEST_APPLICATION_FETCHES__: requests })
      navigator.serviceWorker.addEventListener('message', (event) => {
        const data: unknown = event.data
        if (data !== null && typeof data === 'object' && 'type' in data && data.type === 'application-fetch'
          && 'path' in data && typeof data.path === 'string') requests.push(data.path)
      })
    })
    const errors: string[] = []
    const diagnostics: string[] = []
    const missingResources: string[] = []
    const traffic = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 }
    let stage = 'worker failure'
    page.on('pageerror', error => errors.push(`${stage}: ${error.stack ?? error.message}`))
    page.on('crash', () => { console.info(`${name} page renderer crashed during ${stage}`) })
    page.on('websocket', (socket) => {
      socket.on('framesent', (event) => { traffic.sent++; traffic.bytesSent += Buffer.byteLength(event.payload) })
      socket.on('framereceived', (event) => { traffic.received++; traffic.bytesReceived += Buffer.byteLength(event.payload) })
    })
    page.on('console', (message) => {
      if (['warning', 'error'].includes(message.type())) diagnostics.push(message.text().slice(0, 500))
    })
    page.on('response', (response) => {
      if (response.status() >= 400) missingResources.push(`${response.status()} ${new URL(response.url()).pathname}`)
    })
    // Never expose enrollment material in a navigation error or a failure screenshot.
    const startedAt = performance.now()
    await page.goto(authorization.pairingUrl, { waitUntil: 'domcontentloaded' }).catch(() => { throw new Error('Phone navigation failed') })
    await page.locator('.full-content[data-state="failed"]').waitFor()
    expect(new URL(page.url()).hash).toBe('')
    expect(await page.locator('#app').count()).toBe(0)
    expect(await page.locator('.full-loading').isVisible()).toBe(true)
    expect((await scaffold.ctx.credentials.readRecord(credentialKey('mobile-controller', 'trusted-device')))?.kind).toBe('grant')
    await writeFile(workerPath, workerSource)
    stage = 'startup'
    await page.locator('.full-loading').getByRole('button', { name: '重新加载', exact: true }).click()
    await page.locator('iframe.full-frame').waitFor()
    expect(await page.locator('.full-content').getAttribute('data-state')).toBe('loading')
    expect(await page.locator('.full-loading .full-spinner').isVisible()).toBe(true)
    expect(await page.locator('.full-bar').innerText()).toContain('正在加载应用')
    await saveFailureShot(page, `mobile-full-client-loading-${name.toLowerCase()}`)
    const client = page.frameLocator('iframe.full-frame')
    try {
      await client.locator('[data-composer-input]').first().waitFor({ timeout: 90000 })
    } catch {
      throw new Error(JSON.stringify({ stage: 'phone boot', status: await page.locator('.full-bar').innerText(),
        frames: await Promise.all(page.frames().map(async frame => frame.locator('body').innerText().then(text => text.slice(0, 600)).catch(() => 'unavailable'))), errors, diagnostics, missingResources, traffic }))
    }
    expect(await page.locator('.full-content').getAttribute('data-state')).toBe('ready')
    expect(await page.locator('.full-loading').isVisible()).toBe(false)
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    expect(await page.locator('.full-bar').isVisible()).toBe(false)
    console.info(`${name} full-client cold boot: ${Math.round(performance.now() - startedAt)}ms`)
    expect(new URL(page.url()).hash).toBe('')
    expect(scaffold.ctx.mobileController.status().pairingUrl).toBeUndefined()
    await client.getByRole('textbox', { name: '选择工作区' }).click()
    const directory = client.getByRole('dialog', { name: '选择工作区目录' })
    await directory.waitFor()
    await directory.getByRole('button', { name: '编辑路径' }).click()
    const path = directory.getByRole('textbox', { name: '编辑路径' })
    await path.fill(scaffold.workspaceCwd)
    await path.press('Enter')
    await directory.getByRole('button', { name: '打开', exact: true }).click()
    await client.locator('[data-composer-input][contenteditable="true"]').waitFor()
    const geometry = await client.locator('[data-composer-input]').first().evaluate(element => ({
      fontSize: parseFloat(getComputedStyle(element).fontSize),
      viewport: window.innerWidth,
      centerWidth: document.querySelector('[data-slot="main"]')!.parentElement!.getBoundingClientRect().width,
    }))
    console.info(`${name} phone input/layout: ${JSON.stringify(geometry)}`)
    expect(geometry.fontSize).toBeGreaterThanOrEqual(16)
    expect(geometry.centerWidth).toBe(geometry.viewport)
    const editor = client.locator('[data-composer-input]').first()
    const reopen = client.locator('[data-shell-leading]').getByRole('button', { name: '打开侧边栏', exact: true })
    const drawer = client.getByRole('dialog', { name: '导航', exact: true })
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      await expect.poll(() => editor.evaluate(() =>
        document.querySelector('[data-slot="main"]')!.parentElement!.getBoundingClientRect().width)).toBe(width)
      expect(await editor.evaluate((element) => {
        const box = element.getBoundingClientRect()
        return box.left >= 0 && box.right <= window.innerWidth
          && document.documentElement.scrollWidth === window.innerWidth
      })).toBe(true)
      for (const theme of ['light', 'dark'] as const) {
        stage = `model search ${width}px ${theme}`
        await page.emulateMedia({ colorScheme: theme })
        await expect.poll(() => client.locator('body').getAttribute('data-ds-dark-theme')).toBe(theme === 'dark' ? '' : null)
        await editor.click()
        expect(await editor.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBe(16)
        expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
        await saveFailureShot(page, `mobile-layout-${name.toLowerCase()}-${width}-${theme}`)
        await client.getByRole('button', { name: /^选择模型/ }).click()
        await client.getByRole('menuitem', { name: /^模型/ }).click()
        const search = client.getByRole('searchbox', { name: '搜索模型…', exact: true })
        await search.waitFor()
        expect(await search.evaluate(element => ({
          fontSize: getComputedStyle(element).fontSize,
          focused: element.ownerDocument.activeElement === element,
        }))).toEqual({ fontSize: '16px', focused: true })
        expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
        const menu = client.getByRole('group', { name: '模型与推理等级', exact: true })
        expect(await menu.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return box.left >= 12 && box.right <= window.innerWidth - 12
            && document.documentElement.scrollWidth === window.innerWidth
        })).toBe(true)
        await page.keyboard.insertText('Phone Search 3')
        await expect.poll(() => client.getByRole('menuitemradio').allTextContents()).toEqual(['Phone Search 3'])
        await client.getByRole('button', { name: '清除搜索', exact: true }).click()
        expect(await search.inputValue()).toBe('')
        expect(await client.getByRole('menuitemradio').count()).toBe(5)
        await saveFailureShot(page, `mobile-model-search-${name.toLowerCase()}-${width}-${theme}`)
        await client.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true }).click()
        await menu.waitFor({ state: 'hidden' })
        expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1)
        await reopen.click()
        await drawer.waitFor()
        await drawer.evaluate(async (element) => {
          await Promise.all(element.getAnimations({ subtree: true })
            .filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
            .map(animation => animation.finished))
        })
        expect(await drawer.evaluate((element) => {
          const box = element.getBoundingClientRect()
          return box.left === 0 && box.width <= window.innerWidth - 48
            && document.querySelector('[data-slot="main"]')!.parentElement!.getBoundingClientRect().width === window.innerWidth
        })).toBe(true)
        await saveFailureShot(page, `mobile-drawer-${name.toLowerCase()}-${width}-${theme}`)
        await drawer.getByRole('button', { name: '设置', exact: true }).click()
        const settings = client.getByRole('dialog', { name: '设置', exact: true })
        await settings.waitFor()
        await settings.getByRole('button', { name: '关闭', exact: true }).click()
        expect(await drawer.isVisible()).toBe(true)
        await drawer.getByRole('button', { name: '收起侧边栏', exact: true }).click()
        await drawer.waitFor({ state: 'hidden' })
        expect(await reopen.evaluate(element => document.activeElement === element)).toBe(true)
      }
    }
    await page.emulateMedia({ colorScheme: 'light' })
    await reopen.click()
    await page.keyboard.press('Escape')
    await drawer.waitFor({ state: 'hidden' })
    await reopen.click()
    await client.locator('[data-sidebar-backdrop]').click({ position: { x: 389, y: 400 } })
    await drawer.waitFor({ state: 'hidden' })
    const originalFont = await client.locator('body').evaluate(element => element.style.getPropertyValue('--dsh-content-font-size'))
    try {
      await client.locator('body').evaluate((element) => { element.style.setProperty('--dsh-content-font-size', '20px') })
      expect(await editor.evaluate(element => getComputedStyle(element).fontSize)).toBe('20px')
      await client.getByRole('button', { name: /^选择模型/ }).click()
      await client.getByRole('menuitem', { name: /^模型/ }).click()
      const search = client.getByRole('searchbox')
      expect(await search.evaluate(element => getComputedStyle(element).fontSize)).toBe('20px')
      await client.getByRole('menuitemradio', { name: 'DeepSeek-V4-Flash', exact: true }).click()
    } finally {
      await client.locator('body').evaluate((element, font) => { element.style.setProperty('--dsh-content-font-size', font) }, originalFont)
    }
    const desktop = await browser.newPage({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' })
    try {
      await desktop.goto(scaffold.authenticatedUrl)
      const desktopInput = desktop.locator('[data-composer-input]').first()
      await desktopInput.waitFor()
      expect(await desktop.getByRole('button', { name: /^远程连接:/ }).count()).toBe(0)
      expect(await desktopInput.evaluate(element => getComputedStyle(element).fontSize)).toBe('14px')
      await desktop.getByRole('button', { name: /^选择模型/ }).click()
      await desktop.getByRole('menuitem', { name: /^模型/ }).click()
      const search = desktop.getByRole('searchbox')
      expect(await search.evaluate(element => getComputedStyle(element).fontSize)).toBe('12px')
      await search.press('Escape')
      await desktop.keyboard.press('Escape')
      expect(await desktop.locator('[data-slot="sidebar"]').evaluate(element => element.parentElement!.getBoundingClientRect().width)).toBe(280)
      await desktop.setViewportSize({ width: 800, height: 800 })
      await expect.poll(() => desktop.locator('[data-slot="sidebar"]').evaluate(element => element.parentElement!.getBoundingClientRect().width)).toBe(56)
      expect(await desktop.locator('[data-shell-leading]').count()).toBe(0)
      await desktop.setViewportSize({ width: 390, height: 844 })
      await desktop.locator('[data-shell-leading]').waitFor()
      expect(await desktop.getByRole('button', { name: /^远程连接:/ }).count()).toBe(0)
      await saveFailureShot(desktop, `mobile-layout-tablet-${name.toLowerCase()}`)
    } finally { await desktop.close() }
    await saveFailureShot(page, `mobile-full-client-boot-${name.toLowerCase()}`)
    await client.getByRole('button', { name: /^访问模式/ }).click()
    await client.getByRole('menuitem', { name: '仅可查看', exact: true }).click()
    await client.getByRole('button', { name: '访问模式，当前：仅可查看', exact: true }).waitFor()
    await client.getByRole('button', { name: /^访问模式/ }).click()
    await client.getByRole('menuitem', { name: '工作区内修改', exact: true }).click()
    await client.getByRole('button', { name: /^选择模型/ }).click()
    await client.getByRole('menuitem', { name: /模型/ }).click()
    await client.getByText('DeepSeek', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    expect(await page.evaluate(async (size) => {
      const bridge = (window as Window & {
        __DSH_MOBILE_BRIDGE__?: { fetch(input: string, init?: RequestInit): Promise<Response> }
      }).__DSH_MOBILE_BRIDGE__!
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 251)
      const uploaded = await (await bridge.fetch('/api/mobile-test.transfer', { method: 'POST', body: bytes })).json() as { size: number }
      const downloaded = new Uint8Array(await (await bridge.fetch('/api/mobile-test.transfer')).arrayBuffer())
      return { uploaded: uploaded.size, downloaded: downloaded.length, exact: downloaded.every((byte, index) => byte === index % 251) }
    }, transferSize).catch(() => { throw new Error(JSON.stringify({ stage: 'binary transfer', traffic, errors })) }))
      .toEqual({ uploaded: transferSize, downloaded: transferSize, exact: true })
    const prompts = fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
    const settled = scaffold.whenTurnSettled()
    const input = client.locator('[data-composer-input]').first()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    const sessionId = await settled
    await client.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    const connectionButton = client.getByRole('button', { name: '远程连接: 已连接', exact: true })
    await connectionButton.click()
    const connectionPanel = client.getByRole('dialog', { name: '远程连接', exact: true })
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/mobile-connection.json', import.meta.url)),
      JSON.stringify({
        status: await connectionButton.innerText(),
        panel: await connectionPanel.innerText(),
      }, null, 2), webSnapshotMode())
    await connectionPanel.getByRole('button', { name: '关闭', exact: true }).click()
    const session = scaffold.ctx.sessions.get(sessionId)!
    const selectedBeforeReload = await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current'))
    await compareOrRefreshGolden(fileURLToPath(new URL('../../../snapshots/web/mobile-remote/chat.expected.json', import.meta.url)),
      JSON.stringify(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' || event.type === 'assistant/message')
        .flatMap(event => event.type === 'user/message'
          ? [{ role: 'user', text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('') }]
          : event.type === 'assistant/message' ? [{ role: 'assistant', text: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') }] : []), null, 2), webSnapshotMode())
    const coldAssetRequests = await page.evaluate(() =>
      (window as Window & { __DSH_TEST_APPLICATION_FETCHES__?: string[] }).__DSH_TEST_APPLICATION_FETCHES__!
        .filter(path => path.startsWith('/plugins/') && /[?&]rev=/.test(path)
          || /^\/assets\/[^/]+\.(js|css)$/.test(path)))
    expect(coldAssetRequests.some(path => path.startsWith('/plugins/'))).toBe(true)
    expect(coldAssetRequests.some(path => path.startsWith('/assets/'))).toBe(true)
    await expect.poll(() => page.evaluate(async () => {
      const cache = await caches.open('dsh-mobile-assets-v1')
      return (await cache.keys()).map((key) => {
        const url = new URL(key.url)
        return url.pathname.replace(/^\/asset-cache\/[^/]+/, '') + url.search
      })
    })).toEqual(expect.arrayContaining(coldAssetRequests))
    const reloadedAt = performance.now()
    await page.reload()
    // Reload serves versioned static assets from the worker's per-pairing cache; private responses still have none.
    try { await client.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor({ timeout: 90000 }) }
    catch {
      throw new Error(JSON.stringify({ stage: 'phone refresh', status: await page.locator('.full-bar').innerText(),
        workspaceCount: scaffold.ctx.workspaceRegistry.list().length, selectedBeforeReload,
        selectedAfterReload: await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current')),
        frames: await Promise.all(page.frames().map(async frame => frame.locator('body').innerText().then(text => text.slice(0, 1000)).catch(() => 'unavailable'))), errors, diagnostics, missingResources, traffic }))
    }
    console.info(`${name} full-client refresh: ${Math.round(performance.now() - reloadedAt)}ms`)
    expect(await client.locator('body').evaluate(async () => {
      const responses: unknown[] = []
      for (let index = 0; index < 2; index++) {
        responses.push(await (await fetch('/api/mobile-test.transfer', { method: 'POST', body: 'probe' })).json())
      }
      return responses
    })).toEqual([{ size: 5 }, { size: 5 }])
    const reloadRequests = await page.evaluate(() =>
      (window as Window & { __DSH_TEST_APPLICATION_FETCHES__?: string[] }).__DSH_TEST_APPLICATION_FETCHES__!)
    expect(reloadRequests.filter(path => coldAssetRequests.includes(path))).toEqual([])
    expect(reloadRequests).toContain('/')
    expect(reloadRequests.filter(path => path === '/api/mobile-test.transfer')).toHaveLength(2)
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    await reopen.click()
    await drawer.locator(`[data-row-key="session:${sessionId}"]`).click()
    await drawer.waitFor({ state: 'hidden' })
    await client.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    const agent = scaffold.ctx.agents.get(sessionId)
    if (!agent) throw new Error('phone Session has no active Agent')
    const interaction = new AbortController()
    const asked = scaffold.ctx.userQuestions.ask({
      agent, signal: interaction.signal, questions: [{ id: 'mobile', question: 'PHONE_QUESTION_READY' }],
    })
    const answered = asked.catch((error: unknown) => ({ error }))
    try {
      const question = client.locator('[data-question-key]')
      await question.getByText('PHONE_QUESTION_READY', { exact: true }).waitFor()
      await question.getByRole('button', { name: '跳过', exact: true }).click()
      expect(await answered).toEqual({ answers: [{ id: 'mobile', selected: [] }] })
    } finally { interaction.abort(); await answered }
    session.append('turn/start', { turn: 2 })
    const approvalAbort = new AbortController()
    const approving = scaffold.ctx.approval.request({
      agent, toolName: 'mobile-acceptance', reason: 'PHONE_APPROVAL_READY', signal: approvalAbort.signal,
    })
    const approvalOutcome = approving.catch((error: unknown) => ({ error }))
    try {
      const approval = client.locator('[data-approval-key]')
      await approval.getByText('PHONE_APPROVAL_READY', { exact: true }).waitFor()
      await approval.getByRole('button', { name: '允许一次', exact: true }).click()
      expect(await approvalOutcome).toBe('allowed-once')
    } finally {
      approvalAbort.abort()
      await approvalOutcome
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    }
    await writeFile(join(scaffold.workspaceCwd, 'phone-acceptance.txt'), 'PHONE_FILE_READY\n')
    await client.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
    await client.locator('[data-sidebar-right-guide-entry="files"]').click()
    await client.getByText('phone-acceptance.txt', { exact: true }).waitFor()
    await client.locator('[data-dockkit-add-tab]').click()
    await client.locator('[data-sidebar-right-guide-entry="terminal"]').getByRole('button', { name: /^新建终端/ }).click()
    const terminal = client.locator('[data-sidebar-terminal]')
    await terminal.locator('.xterm-helper-textarea').click()
    await page.keyboard.insertText('node -e "require(\'fs\').writeFileSync(\'phone-terminal.txt\',\'PHONE_TERMINAL_READY\')"')
    await page.keyboard.press('Enter')
    await expect.poll(() => readFile(join(scaffold!.workspaceCwd, 'phone-terminal.txt'), 'utf8')).toBe('PHONE_TERMINAL_READY')
    expect(scaffold.ctx.terminalController.list(agent.id)).toHaveLength(1)
    stage = 'host recovery'
    const mobileEntry = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'mobile-controller')
    if (!mobileEntry) throw new Error('phone controller Loader entry unavailable')
    await mobileEntry.update({ disabled: true })
    await client.getByRole('button', { name: '远程连接: 已断开', exact: true }).waitFor()
    await mobileEntry.update({ disabled: false })
    await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
    await terminal.waitFor()
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(errors, JSON.stringify({ diagnostics, missingResources })).toEqual([])
    expect(missingResources).toEqual([])
    expect((await scaffold.ctx.mobileController.stop()).relayRevoked).toBe(true)
    await client.getByRole('button', { name: '远程连接: 需重新配对', exact: true }).waitFor()
  } catch (error) { failure = error }
  finally {
    const cleanups = [async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop()).relayRevoked) throw new Error('Temporary trust revocation unconfirmed')
    }, () => browser?.close(), () => scaffold?.close(), () => relay?.close(),
    () => rm(root, { recursive: true, force: true })]
    for (const cleanup of cleanups) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Phone acceptance and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})
