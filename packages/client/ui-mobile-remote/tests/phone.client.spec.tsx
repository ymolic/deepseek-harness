// @vitest-environment jsdom
/** Phone controls consume one shell source and preserve modal focus ownership. */
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PhoneConnection } from '../src/client/PhoneConnection.tsx'
import { phoneAdapter, type PhoneControl, type PhoneState } from '../src/client/phone.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)

it('omits old-shell capabilities and releases the mounted handoff on unload', () => {
  expect(phoneAdapter(undefined)).toBeUndefined()
  const release = vi.fn(), unsubscribe = vi.fn(), listener = vi.fn()
  const state: PhoneState = { phase: 'connected', canReconnect: true, canForget: true }
  const registerEntry = vi.fn(() => release), reconnect = vi.fn(), forget = vi.fn(async () => {})
  const subscribe = vi.fn(() => unsubscribe)
  const control: PhoneControl = {
    getSnapshot: () => state,
    subscribe, registerEntry, reconnect, forget,
  }
  const adapter = phoneAdapter(control)!
  expect(adapter.face.hooks.phone.getSnapshot()).toBe(state)
  const detach = adapter.face.hooks.phone.subscribe(listener)
  expect(subscribe).toHaveBeenCalledWith(listener)
  detach()
  expect(unsubscribe).toHaveBeenCalledOnce()
  adapter.face.reconnect()
  adapter.face.forget()
  const button = document.createElement('button')
  adapter.face.entryRef(button)
  expect(registerEntry).toHaveBeenCalledWith(button)
  adapter.face.entryRef(null)
  adapter.face.entryRef(button)
  adapter.dispose()
  adapter.face.entryRef(button)
  adapter.face.reconnect()
  adapter.face.forget()
  expect(release).toHaveBeenCalledTimes(2)
  expect(registerEntry).toHaveBeenCalledTimes(2)
  expect(reconnect).toHaveBeenCalledOnce()
  expect(forget).toHaveBeenCalledOnce()
})

it.each([en, zh])('opens and closes without reconnecting, traps focus, and confirms forgetting explicitly', (dictionary) => {
  const reconnect = vi.fn(), forget = vi.fn(), entryRef = vi.fn()
  const strings: Readonly<Record<string, string>> = dictionary
  let state: PhoneState = { phase: 'connected', canReconnect: true, canForget: true }
  const props: ComponentProps<typeof PhoneConnection> = {
    ...({} as GlobalStandardProps),
    entryRef, reconnect, forget,
    usePhone: selector => selector(state),
    t: key => strings[key] ?? key,
  }
  const view = render(<PhoneConnection {...props} />)
  const trigger = view.getByRole('button', { name: `${dictionary.phoneTitle}: ${dictionary['phone.connected']}` })
  fireEvent.click(trigger)
  let dialog = view.getByRole('dialog', { name: dictionary.phoneTitle })
  expect(dialog.contains(document.activeElement)).toBe(true)
  fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
  expect(document.activeElement?.textContent).toBe(dictionary.phoneForget)
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(reconnect).not.toHaveBeenCalled()
  fireEvent.click(trigger)
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneForget }))
  expect(view.getByText(dictionary.phoneForgetDescription)).toBeTruthy()
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneCancel }))
  expect(forget).not.toHaveBeenCalled()
  expect(view.queryByRole('dialog', { name: dictionary.phoneForgetTitle })).toBeNull()
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneForget }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(view.queryByRole('dialog', { name: dictionary.phoneForgetTitle })).toBeNull()
  expect(view.getByRole('dialog', { name: dictionary.phoneTitle })).toBeTruthy()
  expect(forget).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneReconnect }))
  expect(reconnect).toHaveBeenCalledOnce()
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneForget }))
  fireEvent.click(view.getByRole('button', { name: dictionary.phoneConfirm }))
  expect(forget).toHaveBeenCalledOnce()
  for (const phase of ['connecting', 'offline', 'unavailable', 'pairing', 'replaced', 'revoking', 'revoke-unconfirmed'] as const) {
    state = { phase, canReconnect: ['connecting', 'offline', 'unavailable'].includes(phase), canForget: phase !== 'revoking' }
    act(() => { view.rerender(<PhoneConnection {...props} />) })
    dialog = view.getByRole('dialog', { name: dictionary.phoneTitle })
    expect(dialog.textContent).toContain(dictionary[`phone.reason.${phase}`])
    expect(view.queryByRole('button', { name: dictionary.phoneReconnect }) !== null).toBe(state.canReconnect)
    expect((view.getByRole('button', { name: dictionary.phoneForget }) as HTMLButtonElement).disabled).toBe(!state.canForget)
  }
  fireEvent.click(view.getByRole('button', { name: dictionary.close }))
  expect(view.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(entryRef).toHaveBeenCalledTimes(1)
})
