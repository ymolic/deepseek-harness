/** Desktop-only module loading, failure propagation, and teardown before activation. */
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.doUnmock('../src/client/desktop.ts')
  vi.unstubAllGlobals()
  vi.resetModules()
})

it('does not request the Desktop implementation in a browser', async () => {
  const load = vi.fn(() => { throw new Error('Desktop module requested by a browser') })
  vi.doMock('../src/client/desktop.ts', load)
  const { apply } = await import('../src/client/index.ts')
  await apply({} as never)
  expect(load).not.toHaveBeenCalled()
})

it('awaits the Desktop module and activates it once', async () => {
  vi.stubGlobal('dshDesktop', {})
  const install = vi.fn()
  vi.doMock('../src/client/desktop.ts', () => ({ apply: install }))
  const { apply } = await import('../src/client/index.ts')
  const ctx = { effect: vi.fn() }
  await apply(ctx as never)
  expect(install).toHaveBeenCalledExactlyOnceWith(ctx)
})

it('leaves no account registrations when the module fails to load', async () => {
  vi.stubGlobal('dshDesktop', {})
  const failure = new Error('Desktop module unavailable')
  vi.doMock('../src/client/desktop.ts', () => { throw failure })
  const { apply } = await import('../src/client/index.ts')
  const ctx = { effect: vi.fn(), slots: { register: vi.fn() } }
  await expect(apply(ctx as never)).rejects.toBeDefined()
  expect(ctx.slots.register).not.toHaveBeenCalled()
})

it('does not register account UI when unloaded during module loading', async () => {
  vi.stubGlobal('dshDesktop', {})
  const loading = Promise.withResolvers<undefined>()
  const entered = Promise.withResolvers<undefined>()
  const install = vi.fn()
  vi.doMock('../src/client/desktop.ts', async () => {
    entered.resolve(undefined)
    await loading.promise
    return { apply: install }
  })
  const { apply } = await import('../src/client/index.ts')
  let dispose: (() => void) | undefined
  const pending = apply({ effect: (effect: () => () => void) => { dispose = effect() } } as never)
  try {
    await entered.promise
    dispose!()
  } finally {
    loading.resolve(undefined)
    await pending
  }
  expect(install).not.toHaveBeenCalled()
})
