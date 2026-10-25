import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileDesktopState, MobilePairingTarget, MobileStartResult, MobileStartRequest } from '@deepseek-ai/dsh-api-mobile-controller/types'
import { MobileModel, type MobileOperations } from '../src/client/model.ts'

const qr = vi.hoisted(() => vi.fn(async (url: string) => `data:image/png;base64,${url}`))
vi.mock('qrcode/lib/browser.js', () => ({ default: { toDataURL: qr } }))

const stopped: MobileDesktopState = { phase: 'stopped', sessionId: null, title: '', expiresAt: null, ticketExpiresAt: null, relayRevoked: true }
const waiting: MobileDesktopState = { ...stopped, phase: 'waiting', sessionId: SessionId('selected'), title: 'Selected',
  expiresAt: Date.now() + 600000, ticketExpiresAt: Date.now() + 120000, relayRevoked: false }
const operations = (): MobileOperations => ({ status: async () => stopped,
  start: async () => ({ state: waiting, pairingUrl: 'https://relay.invalid/#synthetic-fixture' }), stop: async () => stopped })

afterEach(() => { vi.useRealTimers() })

describe('desktop mobile authorization model', () => {
  it('isolates pending operations, failures, QR material and revocation across browser and App models', async () => {
    const browserStart = Promise.withResolvers<MobileStartResult>()
    const appStart = Promise.withResolvers<MobileStartResult>()
    const browserUrl = 'https://relay.invalid/#synthetic-browser-room'
    const appUrl = 'dshapp://relay.invalid/#synthetic-app-room'
    const status = vi.fn(async (_target: MobilePairingTarget) => stopped)
    const start = vi.fn((request: MobileStartRequest) =>
      'scope' in request && request.target === 'app' ? appStart.promise : browserStart.promise)
    const stop = vi.fn(async (_target: MobilePairingTarget) => stopped)
    const api: MobileOperations = { status, start, stop }
    const browser = new MobileModel(api, 2000, 'browser')
    const app = new MobileModel(api, 2000, 'app')
    try {
      const browserPending = browser.start()
      const appPending = app.start()
      expect(start.mock.calls.map(([request]) => request)).toEqual([
        { scope: 'instance', acknowledgeTools: true, target: 'browser' },
        { scope: 'instance', acknowledgeTools: true, target: 'app' },
      ])
      appStart.resolve({ state: waiting, pairingUrl: appUrl })
      await appPending
      expect(app.source.getSnapshot().qr).toBe(`data:image/png;base64,${appUrl}`)
      expect(browser.source.getSnapshot().busy).toBe(true)
      expect(app.source.getSnapshot().busy).toBe(false)
      browserStart.reject(new Error('synthetic browser failure'))
      await browserPending
      expect(browser.source.getSnapshot().failed).toBe(true)
      expect(app.source.getSnapshot().failed).toBe(false)
      api.start = async () => ({ state: waiting, pairingUrl: browserUrl })
      await browser.start()
      const browserView = browser.source.getSnapshot()
      await app.stop()
      expect(stop).toHaveBeenCalledWith('app')
      expect(browser.source.getSnapshot()).toBe(browserView)
      expect(app.source.getSnapshot().qr).toBeNull()
      await Promise.all([browser.refresh(), app.refresh()])
      expect(status.mock.calls.map(([target]) => target)).toEqual(['browser', 'app'])
      expect(qr).toHaveBeenCalledWith(appUrl, expect.any(Object))
      expect(qr).toHaveBeenCalledWith(browserUrl, expect.any(Object))
    } finally { await Promise.all([browser.dispose(), app.dispose()]) }
  })

  it('renders the Host App enrollment URL verbatim when status restores a waiting ticket', async () => {
    const pairingUrl = 'dshapp://relay.invalid/#synthetic-restored-app-room'
    const api = operations(); api.status = async () => ({ ...waiting, pairingUrl })
    const model = new MobileModel(api, 2000, 'app')
    try {
      await model.refresh()
      expect(qr).toHaveBeenCalledWith(pairingUrl, expect.any(Object))
      expect(model.source.getSnapshot().qr).toBe(`data:image/png;base64,${pairingUrl}`)
    } finally { await model.dispose() }
  })

  it('erases the enrollment QR after pairing without stopping device trust', async () => {
    const api = operations()
    const model = new MobileModel(api, 2000, 'browser')
    try {
      await model.start()
      api.status = async () => ({ ...waiting, phase: 'paired', expiresAt: null, pairingUrl: 'https://relay.invalid/#must-not-render' })
      await model.refresh()
      expect(model.source.getSnapshot().qr).toBeNull()
      expect(model.source.getSnapshot().state?.phase).toBe('paired')
    } finally { await model.dispose() }
  })
  it('ignores a status read started before a newer authorization', async () => {
    const read = Promise.withResolvers<MobileDesktopState>()
    const api = operations(); api.status = () => read.promise
    const model = new MobileModel(api, 2000, 'browser')
    try {
      const refreshing = model.refresh()
      await model.start()
      read.resolve(stopped); await refreshing
      expect(model.source.getSnapshot().state?.phase).toBe('waiting')
      expect(model.source.getSnapshot().qr?.startsWith('data:image/png')).toBe(true)
    } finally { read.resolve(stopped); await model.dispose() }
  })

  it('keeps authorization when the dialog closes and erases QR on explicit stop', async () => {
    const api = operations(); const stop = vi.fn(api.stop); api.stop = stop
    const model = new MobileModel(api, 2000, 'browser')
    try {
      await model.start()
      model.showing(false)
      expect(stop).not.toHaveBeenCalled()
      expect(model.source.getSnapshot().state?.phase).toBe('waiting')
      await model.stop()
      expect(stop).toHaveBeenCalledOnce()
      expect(model.source.getSnapshot().qr).toBeNull()
      expect(model.source.getSnapshot().state?.relayRevoked).toBe(true)
    } finally { await model.dispose() }
  })

  it('preserves an operation failure across successful background reads', async () => {
    const api = operations(); api.start = async () => { throw new Error('fixture unavailable') }
    const model = new MobileModel(api, 2000, 'browser')
    try {
      await model.start()
      await model.refresh()
      expect(model.source.getSnapshot().failed).toBe(true)
      expect(model.source.getSnapshot().busy).toBe(false)
    } finally { await model.dispose() }
  })

  it('explicit stop interrupts a pending authorization and suppresses its late QR', async () => {
    const pending = Promise.withResolvers<MobileStartResult>()
    const api = operations(); api.start = () => pending.promise
    const stop = vi.fn(api.stop); api.stop = stop
    const model = new MobileModel(api, 2000, 'browser')
    try {
      const starting = model.start()
      await model.stop()
      expect(stop).toHaveBeenCalledOnce()
      pending.resolve({ state: waiting, pairingUrl: 'https://relay.invalid/#synthetic-fixture' })
      await starting
      expect(model.source.getSnapshot().state).toEqual(stopped)
      expect(model.source.getSnapshot().qr).toBeNull()
    } finally { pending.resolve({ state: stopped, pairingUrl: '' }); await model.dispose() }
  })

  it('unload waits for its read, releases polling and prevents late publication', async () => {
    vi.useFakeTimers()
    const pending = Promise.withResolvers<MobileDesktopState>()
    const api = operations(); api.status = () => pending.promise
    const model = new MobileModel(api, 2000, 'browser')
    void model.refresh()
    const disposing = model.dispose()
    pending.resolve(waiting)
    await disposing
    expect(vi.getTimerCount()).toBe(0)
    expect(model.source.getSnapshot().state).toBeNull()
    expect(model.source.getSnapshot().qr).toBeNull()
  })
})
