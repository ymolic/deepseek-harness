// @vitest-environment jsdom
/** Browser and App controls consume independent model seats and locale-owned guidance. */
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { MobileDesktopState } from '@deepseek-ai/dsh-api-mobile-controller/types'
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { MobileDialog, MobileMenu, MobileTargetCard } from '../src/client/MobileDialog.tsx'
import { createMobileViewStore } from '../src/client/index.ts'
import type { MobileView } from '../src/client/model.ts'
import { en, zh } from '../src/client/locales.ts'

const stopped: MobileDesktopState = {
  phase: 'stopped', sessionId: null, title: '', expiresAt: null, ticketExpiresAt: null, relayRevoked: true,
}
const freshView = (): MobileView => ({ state: stopped, qr: null, busy: false, failed: false })

afterEach(cleanup)

it.each([en, zh])('keeps consent, status, QR display, errors and controls independent in both locales', (dictionary) => {
  const strings: Readonly<Record<string, string>> = dictionary
  const t: ComponentProps<typeof MobileTargetCard>['t'] = key => strings[key] ?? key
  let browser = freshView(), app = freshView()
  const browserStart = vi.fn(async () => {}), appStart = vi.fn(async () => {})
  const browserStop = vi.fn(async () => {}), appStop = vi.fn(async () => {})
  const browserRefresh = vi.fn(async () => {}), appRefresh = vi.fn(async () => {})
  const browserShowing = vi.fn(), appShowing = vi.fn()
  const browserProps: ComponentProps<typeof MobileTargetCard> = {
    ...({} as GlobalStandardProps), target: 'browser', t,
    useMobile: selector => selector(browser), start: browserStart, stop: browserStop,
    refresh: browserRefresh, showing: browserShowing,
  }
  const appProps: ComponentProps<typeof MobileTargetCard> = {
    ...({} as GlobalStandardProps), target: 'app', t,
    useMobile: selector => selector(app), start: appStart, stop: appStop,
    refresh: appRefresh, showing: appShowing,
  }
  const view = render(<><MobileTargetCard {...browserProps} /><MobileTargetCard {...appProps} /></>)
  const browserCard = within(view.getByRole('region', { name: dictionary['target.browser'] }))
  const appCard = within(view.getByRole('region', { name: dictionary['target.app'] }))
  expect(browserCard.getByText(dictionary['scan.browser'])).toBeTruthy()
  expect(appCard.getByText(dictionary['scan.app'])).toBeTruthy()
  expect(browserCard.getByRole<HTMLButtonElement>('button', { name: dictionary.authorize }).disabled).toBe(true)
  expect(appCard.getByRole<HTMLButtonElement>('button', { name: dictionary.authorize }).disabled).toBe(true)
  fireEvent.click(browserCard.getByRole('checkbox', { name: dictionary['consent.browser'] }))
  fireEvent.click(browserCard.getByRole('button', { name: dictionary.authorize }))
  expect(browserStart).toHaveBeenCalledOnce()
  expect(appStart).not.toHaveBeenCalled()
  expect(browserCard.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)
  expect(appCard.getByRole<HTMLInputElement>('checkbox').checked).toBe(false)

  browser = { ...browser, busy: true }
  act(() => { view.rerender(<><MobileTargetCard {...browserProps} /><MobileTargetCard {...appProps} /></>) })
  expect(browserCard.getByRole('status').textContent).toBe(dictionary.working)
  fireEvent.click(appCard.getByRole('checkbox', { name: dictionary['consent.app'] }))
  fireEvent.click(appCard.getByRole('button', { name: dictionary.authorize }))
  expect(appStart).toHaveBeenCalledOnce()
  browser = { ...browser, busy: false, failed: true }
  app = { ...app, state: { ...stopped, phase: 'waiting', relayRevoked: false }, qr: 'data:image/png;base64,synthetic-app' }
  act(() => { view.rerender(<><MobileTargetCard {...browserProps} /><MobileTargetCard {...appProps} /></>) })
  expect(browserCard.getByRole('alert').textContent).toContain(dictionary.error)
  expect(appCard.queryByRole('alert')).toBeNull()
  expect(appCard.getByRole('img', { name: dictionary['qr.app'] }).getAttribute('src')).toBe(app.qr)
  expect(browserCard.queryByRole('img')).toBeNull()
  fireEvent.click(browserCard.getByRole('button', { name: dictionary.retry }))
  expect(browserRefresh).toHaveBeenCalledOnce()
  expect(appRefresh).not.toHaveBeenCalled()
  fireEvent.click(appCard.getByRole('button', { name: dictionary.stop }))
  expect(appStop).toHaveBeenCalledOnce()
  expect(browserStop).not.toHaveBeenCalled()

  app = { ...app, state: { ...stopped, phase: 'paired', mobileOnline: true, relayRevoked: false }, qr: null }
  act(() => { view.rerender(<><MobileTargetCard {...browserProps} /><MobileTargetCard {...appProps} /></>) })
  expect(appCard.queryByRole('img')).toBeNull()
  expect(appCard.getByText(dictionary.refreshHint)).toBeTruthy()
  expect(appCard.getByRole<HTMLButtonElement>('button', { name: dictionary.refresh }).disabled).toBe(true)
  fireEvent.click(appCard.getByRole('checkbox', { name: dictionary['consent.app'] }))
  fireEvent.click(appCard.getByRole('button', { name: dictionary.refresh }))
  expect(appStart).toHaveBeenCalledTimes(2)
  expect(browserStart).toHaveBeenCalledOnce()
  expect(appCard.getByText(dictionary.online)).toBeTruthy()
  view.unmount()
  expect(browserShowing.mock.calls).toEqual([[true], [false]])
  expect(appShowing.mock.calls).toEqual([[true], [false]])
})

it('reports expired tickets, uncertain revocation and target-local disabled state', () => {
  let state = freshView()
  const props: ComponentProps<typeof MobileTargetCard> = {
    ...({} as GlobalStandardProps), target: 'app', t: key => en[key as keyof typeof en] ?? key,
    useMobile: selector => selector(state), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    refresh: vi.fn(async () => {}), showing: vi.fn(),
  }
  state = { ...state, state: { ...stopped, phase: 'waiting', relayRevoked: false } }
  const view = render(<MobileTargetCard {...props} />)
  expect(view.getByText(en.ticketExpired)).toBeTruthy()
  state = { ...state, state: { ...stopped, relayRevoked: false } }
  view.rerender(<MobileTargetCard {...props} />)
  expect(view.getByRole('alert').textContent).toBe(en.revokeUnknown)
  fireEvent.click(view.getByRole('button', { name: en.stop }))
  expect(props.stop).toHaveBeenCalledOnce()
  state = { ...state, state: { ...stopped, phase: 'disabled' } }
  view.rerender(<MobileTargetCard {...props} />)
  expect(view.queryByRole('checkbox')).toBeNull()
  expect(view.getByRole('status').textContent).toBe(en.disabled)
})

it('opens a shared dialog with browser and App slots and closes without revoking either', () => {
  const store = createMobileViewStore().create()
  const useStore: ComponentProps<typeof MobileDialog>['useStore'] = selector => selector(store.getSnapshot())
  const actions = store.actions
  const common = { ...({} as GlobalStandardProps), useStore, actions, t: (key: string) => en[key as keyof typeof en] ?? key }
  const onDismiss = vi.fn()
  const menu = render(<MobileMenu {...common} onDismiss={onDismiss} />)
  fireEvent.click(menu.getByRole('menuitem', { name: en.title }))
  expect(onDismiss).toHaveBeenCalledOnce()
  expect(store.getSnapshot().open).toBe(true)
  const renderSlot: ComponentProps<typeof MobileDialog>['renderSlot'] = (_name, _owner, options) =>
    <p data-testid={`card-${options?.entryKey}`}>{options?.entryKey}</p>
  const props: ComponentProps<typeof MobileDialog> = { ...common, renderSlot }
  const view = render(<MobileDialog {...props} />)
  expect(view.getByRole('dialog', { name: en.title })).toBeTruthy()
  expect(view.getByTestId('card-browser')).toBeTruthy()
  expect(view.getByTestId('card-app')).toBeTruthy()
  expect(view.getByText(en.independent)).toBeTruthy()
  fireEvent.click(view.getAllByRole('button', { name: en.close }).at(-1)!)
  expect(store.getSnapshot().open).toBe(false)
  view.rerender(<MobileDialog {...props} />)
  expect(view.queryByRole('dialog')).toBeNull()
})
