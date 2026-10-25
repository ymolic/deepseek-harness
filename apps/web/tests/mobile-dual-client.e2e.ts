/** Two isolated phone stores exercise the full shipped UI through the deployable relay and real Loader. */
import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { expect, it } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import type { MobilePairingTarget } from '@deepseek-ai/dsh-api-mobile-controller/types'
import { isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'

// This opt-in reads source/assets, never the operator relay's .env or device state.
const relayRoot = process.env.DSH_MOBILE_RELAY_ROOT
const targets = ['browser', 'app'] as const
const trustKeys = {
  browser: credentialKey('mobile-controller', 'trusted-device'),
  app: credentialKey('mobile-controller', 'trusted-app-device'),
}
const consent = {
  browser: '我授权此浏览器完整操作当前 DSH',
  app: '我授权 DSH App 完整操作当前 DSH',
}
interface Relay {
  origin: string
  close(): Promise<void>
}
interface Enrollment {
  url: string
  room: string
  key: string
  ticket: string
}

function enrollment(value: string, target: MobilePairingTarget, origin: string): Enrollment {
  expect(URL.canParse(value)).toBe(true)
  const issued = new URL(value)
  expect(issued.protocol).toBe(target === 'app' ? 'dshapp:' : new URL(origin).protocol)
  expect(issued.host === new URL(origin).host).toBe(true)
  expect(issued.pathname).toBe('/')
  expect(issued.search).toBe('')
  const fragment = new URLSearchParams(issued.hash.slice(1))
  expect([...fragment.keys()].sort()).toEqual(['key', 'mode', 'room', 'ticket'])
  expect(fragment.get('mode')).toBe('full')
  const room = fragment.get('room') ?? ''
  const key = fragment.get('key') ?? ''
  const ticket = fragment.get('ticket') ?? ''
  expect(/^[A-Za-z0-9_-]{24}$/.test(room)).toBe(true)
  expect(/^[A-Za-z0-9_-]{43}$/.test(key)).toBe(true)
  expect(/^[A-Za-z0-9_-]{43}$/.test(ticket)).toBe(true)
  // The native scanner converts to HTTPS; this local fixture instead retains its loopback HTTP origin.
  const url = target === 'app' ? value.replace(/^dshapp:/, new URL(origin).protocol) : value
  expect(new URL(url).origin === origin).toBe(true)
  return { url, room, key, ticket }
}

async function openEnrollment(page: Page, pairing: Enrollment): Promise<void> {
  // Same-path QR fragments otherwise become hash-only navigations and do not rerun the distributor's boot.
  await page.goto('about:blank')
  // Playwright navigation errors include their URL; enrollment material must not enter diagnostics.
  await page.goto(pairing.url, { waitUntil: 'commit' }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : ''
    const category = /timeout/i.test(message) ? 'timeout' : /crash|closed/i.test(message) ? 'closed' : 'navigation'
    throw new Error(`Temporary phone navigation failed (${category})`)
  })
  await fullClientReady(page)
}

async function fullClientReady(page: Page): Promise<void> {
  const client = page.frameLocator('iframe.full-frame')
  await client.locator('[data-composer-input]').first().waitFor({ timeout: 90_000 })
  await client.getByRole('button', { name: '远程连接: 已连接', exact: true }).waitFor()
  await expect.poll(() => page.locator('.full-content').getAttribute('data-state')).toBe('ready')
  expect(await page.locator('iframe.full-frame').count()).toBe(1)
  expect(await page.locator('.full-loading').isVisible()).toBe(false)
  expect(new URL(page.url()).hash === '').toBe(true)
}

async function assertCatalog(page: Page): Promise<void> {
  const result = await page.frameLocator('iframe.full-frame').locator('body').evaluate(async () => {
    const transport = (window as Window & {
      __DSH_TRANSPORT__?: { fetch(input: string, init?: RequestInit): Promise<Response> }
    }).__DSH_TRANSPORT__
    if (!transport) throw new Error('Full application transport missing')
    const rpcId = 'dual-client-read-only-catalog'
    const response = await transport.fetch('/api/session/modelCatalog', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'session/modelCatalog', payload: { args: {} } }),
    })
    const body: unknown = await response.json()
    const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    const result = record(body) && record(body.result) ? body.result : undefined
    const catalog = result?.ok === true && record(result.value) ? result.value : undefined
    const groups = catalog && Array.isArray(catalog.groups) ? catalog.groups : []
    // Only fixed catalog facts leave the page, never a raw response or connection capability.
    return {
      httpStatus: response.status,
      correlated: record(body) && body.rpcId === rpcId,
      ok: result?.ok === true,
      expectedCatalog: groups.some(group => record(group) && group.id === 'deepseek-official' && Array.isArray(group.models)
        && group.models.some(model => record(model) && model.id === 'deepseek-v4-flash')),
      noFailures: catalog !== undefined && Array.isArray(catalog.failures) && catalog.failures.length === 0,
    }
  }).catch(() => { throw new Error('Temporary phone read-only RPC failed') })
  expect(result).toEqual({ httpStatus: 200, correlated: true, ok: true, expectedCatalog: true, noFailures: true })
}

async function assertSession(page: Page, expectedRoom: string): Promise<void> {
  const result = await page.evaluate(async (room) => {
    const response = await fetch('/session', { method: 'POST' })
    const body: unknown = await response.json()
    return { status: response.status, matches: body !== null && typeof body === 'object'
      && 'roomId' in body && body.roomId === room && 'protocol' in body && body.protocol === 2 }
  }, expectedRoom).catch(() => { throw new Error('Temporary relay session check failed') })
  expect(result).toEqual({ status: 200, matches: true })
}

async function assertNoEnrollmentText(page: Page, privateValues: readonly string[]): Promise<void> {
  expect(await page.evaluate((values) => {
    const text = [document.body.innerText, ...Array.from(document.querySelectorAll('iframe'), frame => frame.contentDocument?.body?.innerText ?? '')].join('\n')
    return values.every(value => !text.includes(value))
  }, privateValues)).toBe(true)
}

async function forgetPhone(page: Page): Promise<void> {
  const client = page.frameLocator('iframe.full-frame')
  await client.getByRole('button', { name: /^远程连接:/ }).click()
  await client.getByRole('dialog', { name: '远程连接', exact: true }).getByRole('button', { name: '忘记此设备…', exact: true }).click()
  await client.getByRole('dialog', { name: '忘记此设备？', exact: true }).getByRole('button', { name: '撤销设备信任', exact: true }).click()
  await page.locator('.full-bar').getByText('请在桌面重新生成二维码并扫码', { exact: true }).waitFor()
  expect(await page.locator('iframe.full-frame').count()).toBe(0)
}

async function cards(page: Page) {
  return Promise.all(targets.map(async (target) => {
    const card = page.locator(`[data-mobile-pairing-target="${target}"]`)
    return {
      target,
      heading: await card.getByRole('heading', { level: 3 }).innerText(),
      instructions: await card.locator('p').first().innerText(),
      status: await card.getByRole('status').innerText(),
      consentChecked: await card.getByRole('checkbox', { name: consent[target], exact: true }).isChecked(),
      qrCount: await card.getByRole('img').count(),
      buttons: await card.getByRole('button').allTextContents(),
    }
  }))
}

it.runIf(relayRoot)('keeps Browser and App fully mounted with independent rooms, cookies and trust through refresh and forgetting', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-dual-client-'))
  let relay: Relay | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let failure: unknown
  try {
    const fixture: unknown = await import(pathToFileURL(join(relayRoot!, 'server/relay.mjs')).href)
    if (!isRecord(fixture) || typeof fixture.createRelay !== 'function') throw new Error('Deployable relay fixture unavailable')
    const createRelay = fixture.createRelay as (options: {
      adminToken: string
      desktopToken: string
      origin: string
      stateFile: string
      staticDirectory: string
    }) => Promise<Relay>
    const desktopToken = randomBytes(32).toString('base64url')
    const stateFile = join(root, 'devices.json')
    relay = await createRelay({ adminToken: randomBytes(32).toString('base64url'), desktopToken,
      origin: 'http://127.0.0.1:0', stateFile, staticDirectory: join(relayRoot!, 'public') })
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n- id: ui-mobile-remote\n  config:\n    pollMs: 500\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    const workspace = await ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    const sessionId = SessionId('mobile-header-fixture')
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: scaffold.workspaceCwd, agentPreset: 'standard' },
      agentOptions: ctx.agentDefaultModel.currentSelection(),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    await workspace.attachSession(sessionId)
    const session = handle.agent.session
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'mobile header fixture' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', { turn: 1, step: 1, stream: [], message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'mobile header ready' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }) }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionController.rename({ sessionId, title: 'A long phone session title that must truncate rather than cover header actions' })
    await ctx.sessions.flush(session)
    await handle.dispose()
    await ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), desktopToken)
    browser = await chromium.launch(process.env.BROWSER_EXECUTABLE
      ? { executablePath: process.env.BROWSER_EXECUTABLE }
      : { channel: 'chrome' })
    const desktop = await browser.newPage({ viewport: { width: 1100, height: 900 }, locale: 'zh-CN' })
    // The native shortcut provider is the only platform-specific integration needed by the desktop menu.
    await desktop.addInitScript((snapshot) => { Object.assign(globalThis, { dshDesktop: { protocolVersion: 1,
      keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
      shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }), subscribe: () => () => {},
        recording: async () => {}, edit: async () => ({ status: 'not-ready', snapshot }) },
    } }) }, initialShortcutConfig())
    await desktop.goto(scaffold.authenticatedUrl, { waitUntil: 'load' }).catch(() => { throw new Error('Temporary desktop navigation failed') })
    await desktop.getByRole('button', { name: '账号菜单', exact: true }).click()
    await desktop.getByRole('menuitem', { name: '手机远控', exact: true }).click()
    const dialog = desktop.getByRole('dialog', { name: '手机远控', exact: true })
    const browserCard = dialog.locator('[data-mobile-pairing-target="browser"]')
    const appCard = dialog.locator('[data-mobile-pairing-target="app"]')
    for (const target of targets) {
      const card = dialog.locator(`[data-mobile-pairing-target="${target}"]`)
      await card.getByRole('status').getByText('远控已停止', { exact: true }).waitFor()
      expect(await card.getByRole('button', { name: '配对此端', exact: true }).isDisabled()).toBe(true)
    }
    const initialCards = await cards(desktop)
    for (const width of [1100, 390]) {
      await desktop.setViewportSize({ width, height: 900 })
      for (const direction of ['ltr', 'rtl']) {
        await desktop.evaluate((dir) => { document.documentElement.dir = dir }, direction)
        for (const target of targets) {
          expect(await dialog.locator(`[data-mobile-pairing-target="${target}"]`).evaluate((element) => {
            const rect = element.getBoundingClientRect()
            return rect.left >= 0 && rect.right <= innerWidth && element.scrollWidth <= element.clientWidth
          })).toBe(true)
        }
      }
    }
    await desktop.evaluate(() => { document.documentElement.dir = 'ltr' })
    await desktop.setViewportSize({ width: 1100, height: 900 })
    const browserAuthorization = await ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true })
    expect(browserAuthorization.state.sessionId).toBeNull()
    expect(browserAuthorization.state.expiresAt).toBeNull()
    expect(browserAuthorization.state.scope).toBe('instance')
    const browserPairing = enrollment(browserAuthorization.pairingUrl, 'browser', relay.origin)
    const browserTrust = JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser))
    expect((await ctx.credentials.readRecord(trustKeys.browser))?.kind).toBe('grant')
    await browserCard.getByRole('img').waitFor()
    const browserQr = await browserCard.getByRole('img').getAttribute('src')
    expect(await appCard.getByRole('img').count()).toBe(0)
    expect(await appCard.getByRole('checkbox').isChecked()).toBe(false)
    await appCard.getByRole('checkbox', { name: consent.app, exact: true }).check()
    expect(await browserCard.getByRole('checkbox').isChecked()).toBe(false)
    expect(await browserCard.getByRole('button', { name: '刷新二维码', exact: true }).isDisabled()).toBe(true)
    await appCard.getByRole('button', { name: '配对此端', exact: true }).click()
    await appCard.getByRole('img').waitFor()
    const appPairing = enrollment(ctx.mobileController.status('app').pairingUrl ?? '', 'app', relay.origin)
    expect(browserPairing.room !== appPairing.room).toBe(true)
    expect(browserPairing.key !== appPairing.key).toBe(true)
    expect(browserPairing.ticket !== appPairing.ticket).toBe(true)
    expect(await browserCard.getByRole('img').getAttribute('src') === browserQr).toBe(true)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser)) === browserTrust).toBe(true)
    expect((await ctx.credentials.readRecord(trustKeys.app))?.kind).toBe('grant')
    const privateValues = [desktopToken, browserPairing.room, browserPairing.key, browserPairing.ticket,
      appPairing.room, appPairing.key, appPairing.ticket]
    const browserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
    const appContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', isMobile: true, hasTouch: true })
    const pages = { browser: await browserContext.newPage(), app: await appContext.newPage() }
    for (const page of [pages.browser, pages.app]) await page.addInitScript((id) => {
      if (location.protocol === 'http:' || location.protocol === 'https:') {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
      }
    }, sessionId)
    const sockets = { browser: 0, app: 0 }
    const pageErrors = { browser: 0, app: 0 }
    const payloadKeys = [browserPairing.key, appPairing.key]
    let keyInRequest = false
    for (const target of targets) {
      pages[target].on('pageerror', (error) => {
        pageErrors[target]++
        const diagnostic = privateValues.reduce((text, value) => text.replaceAll(value, '[redacted]'), error.message)
        console.info(`synthetic ${target} client error: ${diagnostic.slice(0, 400)}`)
      })
      pages[target].on('websocket', () => { sockets[target]++ })
      pages[target].on('request', (request) => {
        const url = new URL(request.url())
        keyInRequest ||= payloadKeys.some(key => `${url.pathname}${url.search}`.includes(key))
      })
    }
    await Promise.all([openEnrollment(pages.browser, browserPairing), openEnrollment(pages.app, appPairing)])
    for (const target of targets) {
      await expect.poll(() => ctx.mobileController.status(target).mobileOnline).toBe(true)
      expect(ctx.mobileController.status(target).pairingUrl === undefined).toBe(true)
      await dialog.locator(`[data-mobile-pairing-target="${target}"]`).getByText('此端已连接', { exact: true }).waitFor()
    }
    const headerClient = pages.app.frameLocator('iframe.full-frame')
    await headerClient.getByText('mobile header ready', { exact: true }).waitFor()
    let headerCopy: { title: string; tabs: string[] } | undefined
    for (const width of [320, 390]) {
      await pages.app.setViewportSize({ width, height: 844 })
      for (const direction of ['ltr', 'rtl']) {
        await headerClient.locator('html').evaluate((element, dir) => { element.setAttribute('dir', dir) }, direction)
        const titleRow = headerClient.locator('[data-conversation-title-row]')
        await expect.poll(() => titleRow.evaluate(element => element.getBoundingClientRect().height)).toBe(44)
        const geometry = await titleRow.evaluate((element) => {
          const box = element.getBoundingClientRect()
          const shell = document.querySelector('[data-shell-leading]')!.getBoundingClientRect()
          const tabs = document.querySelector('[data-conversation-tabs]')!.getBoundingClientRect()
          return { titleHeight: box.height, shellHeight: shell.height, tabsHeight: tabs.height,
            rowsOrdered: shell.bottom <= box.top + 1 && box.bottom <= tabs.top + 1,
            controlsFit: Array.from(element.querySelectorAll('button')).filter(button => button.getBoundingClientRect().width > 0)
              .every((button) => {
                const rect = button.getBoundingClientRect()
                return rect.left >= 0 && rect.right <= innerWidth && rect.height >= 44
              }),
            noOverflow: document.documentElement.scrollWidth <= innerWidth }
        })
        expect(geometry).toEqual({ titleHeight: 44, shellHeight: 44, tabsHeight: 44,
          rowsOrdered: true, controlsFit: true, noOverflow: true })
        await titleRow.getByRole('button', { name: '更多操作', exact: true }).click()
        await headerClient.getByRole('menuitem', { name: '下载 Session 日志', exact: true }).waitFor()
        await pages.app.keyboard.press('Escape')
        headerCopy = { title: await titleRow.locator('nav').innerText(), tabs: await headerClient.getByRole('tab').allTextContents() }
      }
    }
    await headerClient.locator('html').evaluate((element) => { element.setAttribute('dir', 'ltr') })
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/mobile-header.json', import.meta.url)),
      JSON.stringify(headerCopy, null, 2), webSnapshotMode())
    await Promise.all([assertCatalog(pages.browser), assertCatalog(pages.app)])
    await assertSession(pages.browser, browserPairing.room)
    await assertSession(pages.app, appPairing.room)
    const browserCookie = (await browserContext.cookies(relay.origin)).find(cookie => cookie.name === 'dsh_relay_session')
    const appCookie = (await appContext.cookies(relay.origin)).find(cookie => cookie.name === 'dsh_relay_session')
    expect(browserCookie !== undefined && appCookie !== undefined && browserCookie.value !== appCookie.value).toBe(true)
    expect(browserCookie?.httpOnly === true && appCookie?.httpOnly === true).toBe(true)
    expect({ browser: browserCookie?.sameSite, app: appCookie?.sameSite }).toEqual({ browser: 'Strict', app: 'Strict' })
    expect(sockets).toEqual({ browser: 1, app: 1 })
    const connectedCards = await cards(desktop)
    expect(connectedCards.every(card => card.qrCount === 0)).toBe(true)
    for (const page of [desktop, pages.browser, pages.app]) await assertNoEnrollmentText(page, privateValues)
    const relayState = await readFile(stateFile, 'utf8')
    expect([browserPairing.key, appPairing.key, browserPairing.ticket, appPairing.ticket,
      browserCookie?.value ?? '', appCookie?.value ?? ''].every(value => value.length > 0 && !relayState.includes(value))).toBe(true)
    const browserFrame = await pages.browser.locator('iframe.full-frame').elementHandle()
    const browserSocketCount = sockets.browser

    // Refresh replaces only App's QR, room and payload key; Browser keeps its mounted application and trust.
    await appCard.getByRole('checkbox', { name: consent.app, exact: true }).check()
    await appCard.getByRole('button', { name: '刷新二维码', exact: true }).click()
    await appCard.getByRole('img').waitFor()
    const refreshedApp = enrollment(ctx.mobileController.status('app').pairingUrl ?? '', 'app', relay.origin)
    expect(refreshedApp.room !== appPairing.room && refreshedApp.key !== appPairing.key).toBe(true)
    expect(refreshedApp.room !== browserPairing.room && refreshedApp.key !== browserPairing.key).toBe(true)
    privateValues.push(refreshedApp.room, refreshedApp.key, refreshedApp.ticket)
    payloadKeys.push(refreshedApp.key)
    expect(ctx.mobileController.status().mobileOnline).toBe(true)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser)) === browserTrust).toBe(true)
    await assertCatalog(pages.browser)
    expect(sockets.browser).toBe(browserSocketCount)
    expect(await pages.browser.locator('iframe.full-frame').evaluate((element, previous) => element === previous, browserFrame)).toBe(true)
    await pages.app.frameLocator('iframe.full-frame').getByRole('button', { name: '远程连接: 需重新配对', exact: true }).waitFor()
    // Revocation of the old room does not implicitly overwrite that context's stored device trust.
    await forgetPhone(pages.app)
    await openEnrollment(pages.app, refreshedApp)
    await assertCatalog(pages.app)
    await assertSession(pages.app, refreshedApp.room)
    await expect.poll(() => ctx.mobileController.status('app').mobileOnline).toBe(true)
    const appTrust = JSON.stringify(await ctx.credentials.readRecord(trustKeys.app))
    const appSocketCount = sockets.app
    await pages.browser.reload().catch(() => { throw new Error('Temporary browser refresh failed') })
    await fullClientReady(pages.browser)
    await assertCatalog(pages.browser)
    expect(sockets.app).toBe(appSocketCount)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.app)) === appTrust).toBe(true)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser)) === browserTrust).toBe(true)
    expect(ctx.mobileController.status('app').mobileOnline).toBe(true)

    // The real App UI revokes its cookie's room. Browser still authenticates, executes read-only RPC, and refreshes.
    await forgetPhone(pages.app)
    await expect.poll(() => ctx.mobileController.status('app').mobileOnline).toBe(false)
    await assertSession(pages.browser, browserPairing.room)
    await assertCatalog(pages.browser)
    expect(ctx.mobileController.status().mobileOnline).toBe(true)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser)) === browserTrust).toBe(true)
    expect((await browserContext.cookies(relay.origin)).some(cookie => cookie.name === 'dsh_relay_session' && cookie.value === browserCookie?.value)).toBe(true)
    expect((await appContext.cookies(relay.origin)).some(cookie => cookie.name === 'dsh_relay_session')).toBe(false)
    await pages.browser.reload().catch(() => { throw new Error('Temporary browser refresh after App revocation failed') })
    await fullClientReady(pages.browser)
    await assertCatalog(pages.browser)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.browser)) === browserTrust).toBe(true)
    expect((await ctx.mobileController.stop('app')).relayRevoked).toBe(true)
    expect(await ctx.credentials.readRecord(trustKeys.app) === undefined).toBe(true)
    expect(ctx.mobileController.status().mobileOnline).toBe(true)
    expect(await pages.app.evaluate(async () => (await fetch('/session', { method: 'POST' })).status)).toBe(401)

    // The inverse direction also holds: the default browser-only stop cannot revoke an enrolled App.
    const finalApp = enrollment((await ctx.mobileController.start({ scope: 'instance', acknowledgeTools: true, target: 'app' })).pairingUrl,
      'app', relay.origin)
    privateValues.push(finalApp.room, finalApp.key, finalApp.ticket)
    payloadKeys.push(finalApp.key)
    await openEnrollment(pages.app, finalApp)
    await assertCatalog(pages.app)
    const finalAppTrust = JSON.stringify(await ctx.credentials.readRecord(trustKeys.app))
    const finalAppSockets = sockets.app
    expect((await ctx.mobileController.stop()).relayRevoked).toBe(true)
    expect(await ctx.credentials.readRecord(trustKeys.browser) === undefined).toBe(true)
    expect(ctx.mobileController.status('app').mobileOnline).toBe(true)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.app)) === finalAppTrust).toBe(true)
    await assertSession(pages.app, finalApp.room)
    await assertCatalog(pages.app)
    expect(sockets.app).toBe(finalAppSockets)
    await pages.app.reload().catch(() => { throw new Error('Temporary App refresh after Browser revocation failed') })
    await fullClientReady(pages.app)
    await assertCatalog(pages.app)
    expect(JSON.stringify(await ctx.credentials.readRecord(trustKeys.app)) === finalAppTrust).toBe(true)
    for (const page of [desktop, pages.browser, pages.app]) await assertNoEnrollmentText(page, privateValues)
    expect(keyInRequest).toBe(false)
    expect(pageErrors).toEqual({ browser: 0, app: 0 })
    await compareOrRefreshGolden(fileURLToPath(new URL('./expected/mobile-dual-connection.json', import.meta.url)),
      JSON.stringify({ initial: initialCards, connected: connectedCards }, null, 2), webSnapshotMode())
  } catch (error) { failure = error }
  finally {
    const cleanups = targets.map(target => async () => {
      if (scaffold && !(await scaffold.ctx.mobileController.stop(target)).relayRevoked) throw new Error(`Temporary ${target} trust revocation unconfirmed`)
    })
    cleanups.push(async () => { await browser?.close() }, async () => { await scaffold?.close() },
      async () => { await relay?.close() }, async () => { await rm(root, { recursive: true, force: true }) })
    for (const cleanup of cleanups) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Dual-client acceptance and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
}, 240_000)
