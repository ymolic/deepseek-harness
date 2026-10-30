// @vitest-environment jsdom
/** The real Web roster shares one launcher action owner across ordinary Web, Desktop and the phone carrier. */
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, expect, onTestFinished, vi } from 'vitest'
import { ok } from '@deepseek-ai/dsh-remote-mock'
import { createClientTest, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'

const SETTINGS = '@deepseek-ai/dsh-client-ui-settings-general'
const ACCOUNT = '@deepseek-ai/dsh-client-ui-settings-account'
const MOBILE = '@deepseek-ai/dsh-client-ui-mobile-remote'
const it = createClientTest({ roster: webApp }, { mount: true })
const unmounted = createClientTest({ roster: webApp })
const stopped = {
  phase: 'stopped', sessionId: null, title: '', expiresAt: null, ticketExpiresAt: null, relayRevoked: true,
}

afterEach(() => { vi.unstubAllGlobals() })

it('opens both pairing cards without a Desktop bridge or any account RPC, then releases and restores the shared owner', async ({ start, mock }) => {
  expect('dshDesktop' in globalThis).toBe(false)
  mock.load({ unary: { 'mobile/status': ok(stopped) } })
  const c = await start()
  // First-run model onboarding is unrelated to this sidebar-menu interaction.
  await c.unload('@deepseek-ai/dsh-client-ui-settings-models')
  await c.flush()
  const trigger = screen.getByRole('button', { name: 'Settings' })
  expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
  act(() => { fireEvent.click(trigger) })
  expect(screen.getAllByRole('menuitem').map(row => row.textContent)).toEqual(['Settings', 'Phone remote control'])
  act(() => { fireEvent.click(screen.getByRole('menuitem', { name: 'Phone remote control' })) })
  expect(screen.queryByRole('menu')).toBeNull()
  const dialog = screen.getByRole('dialog', { name: 'Phone remote control' })
  const cards = within(dialog).getAllByRole('region')
  expect(cards.map(card => card.getAttribute('data-mobile-pairing-target'))).toEqual(['browser', 'app'])
  expect(within(cards[0]!).getByRole('heading', { level: 3 }).textContent).toBe('Browser')
  expect(within(cards[1]!).getByRole('heading', { level: 3 }).textContent).toBe('DSH App')
  await vi.waitFor(() => { expect(within(dialog).getAllByText('Remote control stopped')).toHaveLength(2) })
  await expect(`${dialog.textContent}\n`).toMatchFileSnapshot('./expected/mobile-web-launcher.txt')
  expect(mock.remote.mobile.status).toHaveBeenCalledWith('browser')
  expect(mock.remote.mobile.status).toHaveBeenCalledWith('app')
  expect(mock.log.calls().filter(call => call.endpoint.startsWith('account/'))).toEqual([])
  expect(mock.log.streams().filter(call => call.endpoint.startsWith('account/'))).toEqual([])
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
  await c.reload(SETTINGS)
  await c.flush()
  expect(c.ctx.slots.entries('settings.launcher.actions').map(entry => entry.options.id)).toEqual(['mobile-remote'])
  await c.unload(SETTINGS)
  await c.flush()
  expect(c.ctx.slots.spec('settings.launcher.actions')).toBeUndefined()
}, 60_000)

unmounted('keeps one Desktop menu row and preserves its owner through account unload and reload', async ({ start }) => {
  vi.stubGlobal('dshDesktop', {})
  const c = await start()
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(1)
  const actions = () => c.ctx.slots.entries('settings.launcher.actions').map(entry => entry.options.id)
  expect(actions()).toEqual(['mobile-remote'])
  await c.reload(ACCOUNT)
  await c.flush()
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(1)
  expect(actions()).toEqual(['mobile-remote'])
  await c.unload(ACCOUNT)
  await c.flush()
  expect(c.ctx.slots.entries('settings.launcher')).toHaveLength(0)
  expect(actions()).toEqual(['mobile-remote'])
}, 60_000)

it('leaves full-carrier pairing absent and keeps the existing connection controls', async ({ start, mock }) => {
  expect('dshDesktop' in globalThis).toBe(false)
  const release = vi.fn()
  const state = { phase: 'connected', canReconnect: true, canForget: true } as const
  const control = {
    getSnapshot: () => state,
    subscribe: () => () => {}, registerEntry: vi.fn(() => release), reconnect: vi.fn(), forget: vi.fn(async () => {}),
  }
  vi.stubGlobal('innerWidth', 390)
  vi.stubGlobal('__DSH_TRANSPORT__', { remoteControl: control })
  const c = await start()
  await c.unload('@deepseek-ai/dsh-client-ui-settings-models')
  await c.flush()
  expect(c.ctx.slots.entries('settings.launcher.actions')).toHaveLength(0)
  expect(c.ctx.slots.entries('mobile.remote.dialog.target')).toHaveLength(0)
  const settings = screen.getByRole('button', { name: 'Settings' })
  expect(settings.getAttribute('aria-haspopup')).toBe('dialog')
  const connection = screen.getByRole('button', { name: 'Remote connection: Connected' })
  act(() => { fireEvent.click(connection) })
  const dialog = screen.getByRole('dialog', { name: 'Remote connection' })
  act(() => { fireEvent.click(within(dialog).getByRole('button', { name: 'Reconnect' })) })
  expect(control.reconnect).toHaveBeenCalledOnce()
  expect(mock.log.calls().filter(call => call.endpoint.startsWith('mobile/'))).toEqual([])
  await c.unload(MOBILE)
  await c.flush()
  expect(release).toHaveBeenCalledOnce()
  expect(c.ctx.slots.entries('shell.navigation.actions').some(entry => entry.options.id === 'mobile-connection')).toBe(false)
  onTestFinished(() => { expect(control.forget).not.toHaveBeenCalled() })
}, 60_000)
