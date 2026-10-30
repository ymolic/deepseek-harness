// @vitest-environment jsdom
/** Phone controls consume one shell source and preserve modal focus ownership. */
import type { ComponentProps } from 'react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PhoneConnection } from '../src/client/PhoneConnection.tsx'
import {
  dispatchNativeSwitchInstance, phoneAdapter, readNativeInstances,
  type NativeInstancesPayload, type PhoneControl, type PhoneState,
} from '../src/client/phone.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(() => {
  cleanup()
  delete (globalThis as { __DSH_NATIVE_INSTANCES__?: unknown }).__DSH_NATIVE_INSTANCES__
  delete (globalThis as { webkit?: unknown }).webkit
})

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
    instances: undefined, switchInstance: vi.fn(),
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

it('validates native instances payload strictly and ignores invalid or missing data', () => {
  expect(readNativeInstances(undefined)).toBeUndefined()
  expect(readNativeInstances(null)).toBeUndefined()
  expect(readNativeInstances('invalid')).toBeUndefined()
  expect(readNativeInstances({})).toBeUndefined()
  expect(readNativeInstances({ version: 2, activeId: 'a', instances: [{ id: 'a', label: 'A', kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: '', instances: [{ id: 'a', label: 'A', kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [null] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [{ id: 123, label: 'A', kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [{ id: 'a', label: 123, kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [{ id: 'a', label: '', kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [{ id: 'a', label: 'A', kind: 'unknown' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'b', instances: [{ id: 'a', label: 'A', kind: 'local' }] })).toBeUndefined()
  expect(readNativeInstances({ version: 1, activeId: 'a', instances: [
    { id: 'a', label: 'A', kind: 'local' },
    { id: 'a', label: 'Duplicate', kind: 'cloud' },
  ] })).toBeUndefined()

  const valid: NativeInstancesPayload = {
    version: 1,
    activeId: 'windows',
    instances: [
      { id: 'windows', label: '本地', kind: 'local' },
      { id: 'oracle', label: '云端', kind: 'cloud' },
    ],
  }
  expect(readNativeInstances(valid)).toEqual(valid)

  ;(globalThis as { __DSH_NATIVE_INSTANCES__?: unknown }).__DSH_NATIVE_INSTANCES__ = valid
  expect(readNativeInstances()).toEqual(valid)
})

it('dispatches instance switch requests through control or WebKit message handlers', () => {
  const switchInstance = vi.fn()
  const control: PhoneControl = {
    getSnapshot: () => ({ phase: 'connected', canReconnect: false, canForget: false }),
    subscribe: vi.fn(() => () => {}),
    registerEntry: vi.fn(() => () => {}),
    reconnect: vi.fn(),
    forget: vi.fn(async () => {}),
    switchInstance,
  }

  dispatchNativeSwitchInstance('target-1', control)
  expect(switchInstance).toHaveBeenCalledWith({ targetId: 'target-1' })

  // Suppresses throwing callbacks
  const throwingControl: PhoneControl = { ...control, switchInstance: vi.fn(() => { throw new Error('fail') }) }
  expect(() => { dispatchNativeSwitchInstance('target-throw', throwingControl) }).not.toThrow()

  const postSwitch = vi.fn()
  ;(globalThis as { webkit?: unknown }).webkit = {
    messageHandlers: {
      switchInstance: { postMessage: postSwitch },
    },
  }
  dispatchNativeSwitchInstance('target-2')
  expect(postSwitch).toHaveBeenCalledWith({ targetId: 'target-2' })

  // Suppresses throwing webkit handlers
  ;(globalThis as { webkit?: unknown }).webkit = {
    messageHandlers: {
      switchInstance: { postMessage: () => { throw new Error('post fail') } },
    },
  }
  expect(() => { dispatchNativeSwitchInstance('target-throw-webkit') }).not.toThrow()

  const postDsh = vi.fn()
  ;(globalThis as { webkit?: unknown }).webkit = {
    messageHandlers: {
      dsh: { postMessage: postDsh },
    },
  }
  dispatchNativeSwitchInstance('target-3')
  expect(postDsh).toHaveBeenCalledWith({ action: 'switchInstance', targetId: 'target-3' })

  ;(globalThis as { webkit?: unknown }).webkit = {
    messageHandlers: {
      dsh: { postMessage: () => { throw new Error('dsh fail') } },
    },
  }
  expect(() => { dispatchNativeSwitchInstance('target-throw-dsh') }).not.toThrow()

  // No matching webkit handlers
  ;(globalThis as { webkit?: unknown }).webkit = { messageHandlers: {} }
  expect(() => { dispatchNativeSwitchInstance('target-no-handler') }).not.toThrow()

  const instancesData: NativeInstancesPayload = {
    version: 1,
    activeId: 'local',
    instances: [{ id: 'local', label: '本地', kind: 'local' }],
  }
  const adapterSwitch = vi.fn()
  const adapterControl: PhoneControl = { ...control, instances: instancesData, switchInstance: adapterSwitch }
  const adapter = phoneAdapter(adapterControl)!
  expect(adapter.face.instances).toEqual(instancesData)
  adapter.face.switchInstance('target-4')
  expect(adapterSwitch).toHaveBeenCalledWith({ targetId: 'target-4' })
  adapter.dispose()
  adapter.face.switchInstance('target-5')
  expect(adapterSwitch).toHaveBeenCalledTimes(1)
})

it.each([en, zh])('renders instance section, marks active item, and triggers switchInstance in %s locale', (dictionary) => {
  const switchInstance = vi.fn()
  const instancesData: NativeInstancesPayload = {
    version: 1,
    activeId: 'windows',
    instances: [
      { id: 'windows', label: dictionary['instance.local'], kind: 'local' },
      { id: 'oracle', label: dictionary['instance.cloud'], kind: 'cloud' },
    ],
  }
  const strings: Readonly<Record<string, string>> = dictionary
  const props: ComponentProps<typeof PhoneConnection> = {
    ...({} as GlobalStandardProps),
    entryRef: vi.fn(),
    reconnect: vi.fn(),
    forget: vi.fn(),
    switchInstance,
    instances: instancesData,
    usePhone: selector => selector({ phase: 'connected', canReconnect: true, canForget: true }),
    t: key => strings[key] ?? key,
  }

  const view = render(<PhoneConnection {...props} />)

  const icon = view.getByTestId('instance-kind-icon')
  expect(icon.getAttribute('data-instance-kind')).toBe('local')
  expect(view.getByTestId('instance-icon-local')).toBeTruthy()
  expect(view.queryByTestId('instance-icon-cloud')).toBeNull()

  const trigger = view.getByRole('button', { name: `${dictionary.phoneTitle}: ${dictionary['phone.connected']}` })
  fireEvent.click(trigger)

  expect(view.getByText(dictionary.phoneInstances)).toBeTruthy()

  const localRow = view.getByRole('menuitem', { name: new RegExp(dictionary['instance.local']) })
  const cloudRow = view.getByRole('menuitem', { name: new RegExp(dictionary['instance.cloud']) })
  expect(localRow.getAttribute('aria-current')).toBe('true')
  expect(cloudRow.getAttribute('aria-current')).toBeNull()

  expect(localRow.querySelector('[data-icon="dsw-icon-check-outline-regular"]')).not.toBeNull()
  expect(cloudRow.querySelector('[data-icon="dsw-icon-check-outline-regular"]')).toBeNull()

  fireEvent.click(localRow)
  expect(switchInstance).not.toHaveBeenCalled()
  expect(view.queryByRole('dialog')).toBeNull()

  fireEvent.click(trigger)
  fireEvent.click(view.getByRole('menuitem', { name: new RegExp(dictionary['instance.cloud']) }))
  expect(switchInstance).toHaveBeenCalledWith('oracle')
  expect(view.queryByRole('dialog')).toBeNull()
})

it('maps active cloud instance to cloud icon and hides instances when missing or invalid', () => {
  const strings: Readonly<Record<string, string>> = zh
  const props: ComponentProps<typeof PhoneConnection> = {
    ...({} as GlobalStandardProps),
    entryRef: vi.fn(),
    reconnect: vi.fn(),
    forget: vi.fn(),
    instances: undefined,
    switchInstance: vi.fn(),
    usePhone: selector => selector({ phase: 'connected', canReconnect: false, canForget: false }),
    t: key => strings[key] ?? key,
  }

  const view = render(<PhoneConnection {...props} />)
  expect(view.queryByTestId('instance-kind-icon')).toBeNull()
  fireEvent.click(view.getByRole('button', { name: `${zh.phoneTitle}: ${zh['phone.connected']}` }))
  expect(view.queryByTestId('instances-section')).toBeNull()
  view.unmount()

  const cloudInstances: NativeInstancesPayload = {
    version: 1,
    activeId: 'cloud-vm',
    instances: [
      { id: 'local-pc', label: '本地', kind: 'local' },
      { id: 'cloud-vm', label: '云端', kind: 'cloud' },
    ],
  }
  const viewCloud = render(<PhoneConnection {...props} instances={cloudInstances} />)
  const icon = viewCloud.getByTestId('instance-kind-icon')
  expect(icon.getAttribute('data-instance-kind')).toBe('cloud')
  expect(viewCloud.getByTestId('instance-icon-cloud')).toBeTruthy()
  expect(viewCloud.queryByTestId('instance-icon-local')).toBeNull()
  viewCloud.unmount()

  ;(globalThis as { __DSH_NATIVE_INSTANCES__?: unknown }).__DSH_NATIVE_INSTANCES__ = { version: 99, bad: true }
  const viewInvalid = render(<PhoneConnection {...props} />)
  expect(viewInvalid.queryByTestId('instance-kind-icon')).toBeNull()
  fireEvent.click(viewInvalid.getByRole('button', { name: `${zh.phoneTitle}: ${zh['phone.connected']}` }))
  expect(viewInvalid.queryByTestId('instances-section')).toBeNull()
})
