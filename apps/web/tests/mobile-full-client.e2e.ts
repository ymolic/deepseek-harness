/** Full-client requests against the shipped Loader and registered application services. */
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium, webkit, type Browser } from 'playwright'
import { expect, it, vi } from 'vitest'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-api-mobile-controller'
import type {} from '@deepseek-ai/dsh-api-terminal-controller'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
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
        contextWindow: 1000000, defaultMaxTokens: 256000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' }] }] })
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
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
    const errors: string[] = []
    const diagnostics: string[] = []
    const missingResources: string[] = []
    const traffic = { sent: 0, received: 0, bytesSent: 0, bytesReceived: 0 }
    let stage = 'worker failure'
    page.on('pageerror', error => errors.push(`${stage}: ${error.stack ?? error.message}`))
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
    const session = scaffold.ctx.sessions.get(sessionId)!
    const selectedBeforeReload = await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current'))
    await compareOrRefreshGolden(fileURLToPath(new URL('../../../snapshots/web/mobile-remote/chat.expected.json', import.meta.url)),
      JSON.stringify(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user' || event.type === 'assistant/message')
        .flatMap(event => event.type === 'user/message'
          ? [{ role: 'user', text: event.data.content.filter(part => part.type === 'text').map(part => part.text).join('') }]
          : event.type === 'assistant/message' ? [{ role: 'assistant', text: event.data.message.content.filter(part => part.type === 'text').map(part => part.text).join('') }] : []), null, 2), webSnapshotMode())
    const reloadedAt = performance.now()
    await page.reload()
    // Reload deliberately has no private asset cache, so it owns the same cold-boot budget.
    try { await client.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor({ timeout: 90000 }) }
    catch {
      throw new Error(JSON.stringify({ stage: 'phone refresh', status: await page.locator('.full-bar').innerText(),
        workspaceCount: scaffold.ctx.workspaceRegistry.list().length, selectedBeforeReload,
        selectedAfterReload: await client.locator('body').evaluate(() => localStorage.getItem('dsh.sessions.current')),
        frames: await Promise.all(page.frames().map(async frame => frame.locator('body').innerText().then(text => text.slice(0, 1000)).catch(() => 'unavailable'))), errors, diagnostics, missingResources, traffic }))
    }
    console.info(`${name} full-client refresh: ${Math.round(performance.now() - reloadedAt)}ms`)
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
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
    await page.getByRole('status').getByText('桌面暂时离线，正在自动重连', { exact: true }).waitFor()
    await mobileEntry.update({ disabled: false })
    await page.getByRole('status').getByText('已连接', { exact: true }).waitFor()
    await terminal.waitFor()
    expect(session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(1)
    expect(errors, JSON.stringify({ diagnostics, missingResources })).toEqual([])
    expect(missingResources).toEqual([])
    expect((await scaffold.ctx.mobileController.stop()).relayRevoked).toBe(true)
    await page.getByRole('status').getByText('请在桌面重新生成二维码并扫码', { exact: true }).waitFor()
  } catch (error) { failure = error }
  finally {
    const cleanups = [() => browser?.close(), () => scaffold?.close(), () => relay?.close(),
      () => rm(root, { recursive: true, force: true })]
    for (const cleanup of cleanups) {
      try { await cleanup() }
      catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'Phone acceptance and cleanup failed') }
    }
  }
  if (failure !== undefined) throw failure
})
