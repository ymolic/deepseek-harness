import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileDesktopState, MobileStartResult } from '@deepseek-ai/dsh-api-mobile-controller/types'
import { MobileModel, type MobileOperations } from '../src/client/model.ts'

vi.mock('qrcode/lib/browser.js', () => ({ default: { toDataURL: async () => 'data:image/png;base64,fixture' } }))

const stopped: MobileDesktopState = { phase: 'stopped', sessionId: null, title: '', expiresAt: null, ticketExpiresAt: null, relayRevoked: true }
const waiting: MobileDesktopState = { ...stopped, phase: 'waiting', sessionId: SessionId('selected'), title: 'Selected',
  expiresAt: Date.now() + 600000, ticketExpiresAt: Date.now() + 120000, relayRevoked: false }
const operations = (): MobileOperations => ({ status: async () => stopped,
  start: async () => ({ state: waiting, pairingUrl: 'https://relay.invalid/#synthetic-fixture' }), stop: async () => stopped })

afterEach(() => { vi.useRealTimers() })

describe('desktop mobile authorization model', () => {
  it('ignores a status read started before a newer authorization', async () => {
    const read = Promise.withResolvers<MobileDesktopState>()
    const api = operations(); api.status = () => read.promise
    const model = new MobileModel(api, 2000)
    try {
      const refreshing = model.refresh()
      await model.start({ sessionId: SessionId('selected'), acknowledgeTools: true })
      read.resolve(stopped); await refreshing
      expect(model.source.getSnapshot().state?.phase).toBe('waiting')
      expect(model.source.getSnapshot().qr?.startsWith('data:image/png')).toBe(true)
    } finally { read.resolve(stopped); await model.dispose() }
  })

  it('keeps authorization when the dialog closes and erases QR on explicit stop', async () => {
    const api = operations(); const stop = vi.fn(api.stop); api.stop = stop
    const model = new MobileModel(api, 2000)
    try {
      await model.start({ sessionId: SessionId('selected'), acknowledgeTools: true })
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
    const model = new MobileModel(api, 2000)
    try {
      await model.start({ sessionId: SessionId('selected'), acknowledgeTools: true })
      await model.refresh()
      expect(model.source.getSnapshot().failed).toBe(true)
      expect(model.source.getSnapshot().busy).toBe(false)
    } finally { await model.dispose() }
  })

  it('explicit stop interrupts a pending authorization and suppresses its late QR', async () => {
    const pending = Promise.withResolvers<MobileStartResult>()
    const api = operations(); api.start = () => pending.promise
    const stop = vi.fn(api.stop); api.stop = stop
    const model = new MobileModel(api, 2000)
    try {
      const starting = model.start({ sessionId: SessionId('selected'), acknowledgeTools: true })
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
    const model = new MobileModel(api, 2000)
    void model.refresh()
    const disposing = model.dispose()
    pending.resolve(waiting)
    await disposing
    expect(vi.getTimerCount()).toBe(0)
    expect(model.source.getSnapshot().state).toBeNull()
    expect(model.source.getSnapshot().qr).toBeNull()
  })
})
