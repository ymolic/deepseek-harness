/** Phone commands against the real Loader, Session Controller, loop and durable journal. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { expect, it, vi } from 'vitest'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import { initialShortcutConfig } from '@deepseek-ai/dsh-client-shortcuts/protocol'
import { compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold, selectedSessionFixture, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { mobileRelayFixture } from './mobile-relay-fixture.ts'

const fixturePath = fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat/session.v3.jsonl', import.meta.url))

it('authorizes one real Session, streams its recorded reply once, recovers receipts and revokes on unload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-composition-'))
  const relay = await mobileRelayFixture()
  let scaffold: WebScaffold | undefined
  try {
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: true\n    relayOrigin: ${relay.origin}\n    flushMs: 100\n`)
    const replayFixture = await selectedSessionFixture(fixturePath, false)
    // The phone projects this recorded response, with its own admission metadata and text-only golden.
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture, compareReplaySession: false, paceMs: 25,
      replayProviders: [{ id: 'deepseek-messages', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
        contextWindow: 1000000, defaultMaxTokens: 256000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' }] }] })
    const ctx = scaffold.ctx
    await ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), relay.desktopToken)
    const handle = await ctx.agents.create({ sessionId: SessionId('phone-selected-session'), meta: { cwd: scaffold.workspaceCwd, agentPreset: 'standard' },
      agentOptions: { provider: 'deepseek-messages', model: 'deepseek-v4-flash' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    await expect(ctx.mobileController.start({ sessionId: SessionId('not-selected'), acknowledgeTools: true })).rejects.toThrow()
    expect(relay.created).toBe(0)
    await ctx.sessionController.rename({ sessionId: handle.agent.id, title: 'Phone acceptance session' })
    const authorization = await ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })
    expect(authorization.state.title).toBe('Phone acceptance session')
    const phone = relay.pair(authorization.pairingUrl)
    await expect.poll(() => phone.replies.some(reply => reply.type === 'state')).toBe(true)
    const prompts = fixtureUserPrompts(await readFile(replayFixture, 'utf8'))
    expect(prompts).toHaveLength(1)
    const request = { type: 'send', id: 'phone-request-0001', text: prompts[0]! }
    const settled = scaffold.whenTurnSettled()
    phone.send(request); phone.send(request)
    await settled
    await expect.poll(() => phone.replies.some(reply => reply.type === 'state' && reply.value.status === 'idle'
      && reply.value.messages.some(message => message.text.includes('MESSAGES_WEB_READY'))), { timeout: 10000 }).toBe(true)
    const authored = handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
    expect(authored).toHaveLength(1)
    const last = phone.replies.findLast(reply => reply.type === 'state' && reply.value.status === 'idle')
    if (!last || last.type !== 'state') throw new Error('missing settled phone state')
    await compareOrRefreshGolden(fileURLToPath(new URL('../../../snapshots/web/mobile-remote/chat.expected.json', import.meta.url)),
      JSON.stringify(last.value.messages.map(({ role, text }) => ({ role, text })), null, 2), webSnapshotMode())
    expect(phone.errors).toEqual([])
    expect(phone.replies.filter(reply => reply.type === 'receipt' && reply.status === 'accepted')).toHaveLength(2)
    phone.detach()
    const refreshed = relay.pair(authorization.pairingUrl)
    await expect.poll(() => refreshed.replies.some(reply => reply.type === 'state')).toBe(true)
    refreshed.send({ type: 'receipt', id: request.id })
    await expect.poll(() => refreshed.replies.some(reply => reply.type === 'receipt' && reply.status === 'accepted')).toBe(true)
    refreshed.send({ ...request, text: 'different text' })
    await expect.poll(() => refreshed.replies.some(reply => reply.type === 'receipt' && reply.status === 'conflict')).toBe(true)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    relay.revocation(false)
    expect((await ctx.mobileController.stop()).relayRevoked).toBe(false)
    expect(refreshed.online).toBe(false)
    expect(ctx.mobileController.status().phase).toBe('stopped')
    relay.revocation(true)
    expect((await ctx.mobileController.stop()).relayRevoked).toBe(true)
    expect(relay.activeRooms).toBe(0)
    refreshed.detach()
    const renewed = await ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })
    const other = relay.pair(renewed.pairingUrl)
    await expect.poll(() => other.replies.some(reply => reply.type === 'state')).toBe(true)
    other.send({ type: 'send', id: 'phone-request-0002', text: 'forbidden', sessionId: 'another-session' })
    await expect.poll(() => other.replies.some(reply => reply.type === 'state')).toBe(true)
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    await ctx.mobileController.stop()
    expect(relay.activeRooms).toBe(0)
    other.detach()
    await ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })
    const held = relay.holdNextRevocation()
    const replacing = expect(ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })).rejects.toThrow()
    try {
      await held.entered
      const stopping = ctx.mobileController.stop()
      held.release()
      await replacing
      expect((await stopping).phase).toBe('stopped')
      expect(relay.activeRooms).toBe(0)
    } finally { held.release() }
    const expiring = await ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })
    const expiredPhone = relay.pair(expiring.pairingUrl)
    await expect.poll(() => expiredPhone.replies.some(reply => reply.type === 'state')).toBe(true)
    const clock = vi.spyOn(Date, 'now').mockReturnValue(expiring.state.expiresAt! + 1)
    try {
      expiredPhone.send({ type: 'send', id: 'expired-message-0001', text: 'Must not execute after expiry' })
      await expect.poll(() => ctx.mobileController.status().phase).toBe('expired')
      await expect.poll(() => relay.activeRooms).toBe(0)
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    } finally { clock.mockRestore(); expiredPhone.detach() }
    await ctx.mobileController.start({ sessionId: handle.agent.id, acknowledgeTools: true })
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'mobile-controller')
    expect(entry?.fiber).toBeDefined()
    await entry?.fiber?.dispose()
    expect(relay.activeRooms).toBe(0)
    expect(ctx.get('mobileController')).toBeUndefined()
    await handle.dispose()
  } finally {
    try { await scaffold?.close() }
    finally { try { await relay.close() } finally { await rm(root, { recursive: true, force: true }) } }
  }
})

const launcherCases = [false, true].flatMap(configured => (['web', 'desktop'] as const).map(carrier => ({ configured, carrier })))
it.each(launcherCases)('$carrier launcher enforces consent and owns the QR lifecycle (configured=$configured)', async ({ configured, carrier }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mobile-ui-'))
  const relay = await mobileRelayFixture()
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  try {
    const overlay = join(root, 'mobile.yml')
    await writeFile(overlay, `- id: mobile-controller\n  config:\n    enabled: ${configured}\n    relayOrigin: ${relay.origin}\n`)
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    await scaffold.ctx.credentials.set(credentialRef('DSH_MOBILE_DESKTOP_TOKEN'), relay.desktopToken)
    const handle = await scaffold.ctx.agents.create({ sessionId: SessionId('ui-selected-session'),
      meta: { cwd: scaffold.workspaceCwd }, agentOptions: {} })
    browser = await chromium.launch(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {})
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, locale: 'zh-CN' })
    const pageErrors: string[] = []
    page.on('pageerror', (error) => { pageErrors.push(error.message) })
    const desktopChunks: string[] = []
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.endsWith('/client.desktop.js')) desktopChunks.push(request.url())
    })
    if (carrier === 'desktop') await page.addInitScript((snapshot) => { Object.assign(globalThis, { dshDesktop: { protocolVersion: 1,
      keyboard: { subscribe: () => () => {}, closeWindow: async () => {} },
      shortcuts: { get: async () => ({ ...snapshot, status: 'ready' }), subscribe: () => () => {},
        recording: async () => {}, edit: async () => ({ status: 'not-ready', snapshot }) },
    } }) }, initialShortcutConfig())
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30000 })
    const launcher = page.getByRole('button', { name: carrier === 'desktop' ? '账号菜单' : '设置', exact: true })
    expect(await page.evaluate(() => 'dshDesktop' in globalThis)).toBe(carrier === 'desktop')
    await launcher.click()
    expect(await page.getByRole('menuitem', { name: '手机远控', exact: true }).count()).toBe(1)
    await page.getByRole('menuitem', { name: '手机远控', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '手机远控' })
    await dialog.waitFor()
    const browserCard = dialog.locator('[data-mobile-pairing-target="browser"]')
    const appCard = dialog.locator('[data-mobile-pairing-target="app"]')
    if (!configured) {
      await browserCard.getByText('此桌面尚未配置手机中继', { exact: true }).waitFor()
      await appCard.getByText('此桌面尚未配置手机中继', { exact: true }).waitFor()
      expect(await dialog.getByRole('button', { name: '配对此端' }).count()).toBe(0)
    } else {
      const authorize = browserCard.getByRole('button', { name: '配对此端' })
      expect(await authorize.isDisabled()).toBe(true)
      expect(await dialog.getByRole('button', { name: '选择要授权的会话' }).count()).toBe(0)
      await browserCard.getByRole('checkbox', { name: '我授权此浏览器完整操作当前 DSH' }).check()
      await authorize.click()
      const qr = browserCard.getByRole('img', { name: '私密的一次性浏览器配对二维码' })
      await qr.waitFor()
      expect((await qr.getAttribute('src'))?.startsWith('data:image/png;')).toBe(true)
      expect(relay.created).toBe(1)
      await page.keyboard.press('Escape')
      expect(scaffold.ctx.mobileController.status().phase).toBe('waiting')
      await launcher.click()
      await page.getByRole('menuitem', { name: '手机远控', exact: true }).click()
      await browserCard.getByRole('checkbox', { name: '我授权此浏览器完整操作当前 DSH' }).check()
      await browserCard.getByRole('button', { name: '刷新二维码' }).click()
      await expect.poll(() => relay.created).toBe(2)
      await qr.waitFor()
      expect(relay.activeRooms).toBe(1)
      const paired = relay.pairFull(scaffold.ctx.mobileController.status().pairingUrl!)
      await paired.ready
      await browserCard.getByText('此端已配对', { exact: true }).waitFor()
      expect(await qr.count()).toBe(0)
      expect(await browserCard.getByRole('button', { name: '刷新二维码' }).isDisabled()).toBe(true)
      expect(scaffold.ctx.mobileController.status('app').phase).toBe('stopped')
      expect(await appCard.getByRole('img').count()).toBe(0)
      paired.detach()
      await browserCard.getByRole('button', { name: '忘记此端' }).click()
      await browserCard.getByText('远控已停止', { exact: true }).waitFor()
      expect(relay.activeRooms).toBe(0)
      expect(await qr.count()).toBe(0)
    }
    await page.keyboard.press('Escape')
    expect(await page.getByRole('dialog', { name: '手机远控' }).count()).toBe(0)
    expect(pageErrors).toEqual([])
    if (carrier === 'web') expect(desktopChunks).toEqual([])
    else expect(desktopChunks).toHaveLength(1)
    await handle.dispose()
  } finally {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { try { await relay.close() } finally { await rm(root, { recursive: true, force: true }) } }
    }
  }
})
