/** Nonpersistent desktop view of the Host authorization; QR bytes never leave this model. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MobileDesktopState, MobileStartResult, MobileStartRequest } from '@deepseek-ai/dsh-api-mobile-controller/types'
import QRCode from 'qrcode/lib/browser.js'

/** Plain callbacks keep the model independent of Cordis and generated remotes. */
export interface MobileOperations {
  status: () => Promise<MobileDesktopState>
  start: (request: MobileStartRequest) => Promise<MobileStartResult>
  stop: () => Promise<MobileDesktopState>
}

/** Observable data for both the menu row and overlay. */
export interface MobileView {
  state: MobileDesktopState | null
  qr: string | null
  busy: boolean
  failed: boolean
  now: number
}

/** One plugin-owned status reader with bounded, nonoverlapping polling. */
export class MobileModel {
  readonly source = createSnapshotStore<MobileView>({ state: null, qr: null, busy: false, failed: false, now: Date.now() })
  private disposed = false
  private visible = false
  private generation = 0
  private reading: Promise<void> | undefined
  private operating: Promise<void> | undefined
  private readonly pending = new Set<Promise<void>>()
  private readonly timer: ReturnType<typeof setInterval>

  private current(generation: number): boolean { return !this.disposed && this.generation === generation }

  /** @param operations - trusted desktop Remote calls. @param pollMs - status cadence. */
  constructor(private readonly operations: MobileOperations, pollMs: number) {
    this.timer = setInterval(() => {
      const view = this.source.getSnapshot()
      this.source.update((state) => { state.now = Date.now() })
      if (this.visible || view.state && ['waiting', 'paired', 'reconnecting'].includes(view.state.phase)) void this.refresh()
    }, pollMs)
  }

  /** @param visible - whether the overlay needs current state. */
  showing(visible: boolean): void { this.visible = visible; if (visible) void this.refresh() }

  /** Re-read status without extending authorization. */
  refresh(): Promise<void> {
    if (this.disposed || this.source.getSnapshot().busy) return Promise.resolve()
    if (this.reading) return this.reading
    const generation = this.generation
    const task = (async () => {
      try {
        const value = await this.operations.status()
        if (!this.disposed && this.generation === generation) this.source.update((state) => {
          state.state = value
          if (!['waiting', 'paired', 'reconnecting'].includes(value.phase) || (value.expiresAt !== null && value.expiresAt <= Date.now())) {
            state.qr = null
          }
        })
        if (this.current(generation) && value.pairingUrl && !this.source.getSnapshot().qr) {
          try {
            const qr = await QRCode.toDataURL(value.pairingUrl, { width: 300, margin: 2, errorCorrectionLevel: 'M' })
            if (this.current(generation)) this.source.update((s) => { s.qr = qr })
          } catch {}
        }
      } catch (_error) { if (!this.disposed && this.generation === generation) this.source.update((state) => { state.failed = true }) }
    })()
    this.reading = task
    void task.finally(() => { if (this.reading === task) this.reading = undefined })
    return task
  }

  /** @param request - explicitly acknowledged desktop Session selection. */
  start(request: MobileStartRequest): Promise<void> {
    return this.operate(async (generation) => {
      const value = await this.operations.start(request)
      if (!this.current(generation)) return
      this.source.update((state) => { state.state = value.state })
      const qr = await QRCode.toDataURL(value.pairingUrl, { width: 300, margin: 2, errorCorrectionLevel: 'M' })
      if (this.current(generation)) this.source.update((state) => { state.qr = qr })
    })
  }

  /** Revoke through the Host; hiding the overlay never calls this method. */
  stop(): Promise<void> {
    return this.operate(async (generation) => {
      const value = await this.operations.stop()
      if (!this.disposed && this.generation === generation) this.source.update((state) => { state.state = value })
    }, true)
  }

  private operate(operation: (generation: number) => Promise<void>, interrupt = false): Promise<void> {
    if (this.disposed || this.operating && !interrupt) return this.operating ?? Promise.resolve()
    const generation = ++this.generation
    this.source.update((state) => { state.busy = true; state.failed = false; state.qr = null })
    const task = (async () => {
      try { await operation(generation) }
      catch (_error) { if (!this.disposed && this.generation === generation) this.source.update((state) => { state.failed = true }) }
      finally { if (!this.disposed && this.generation === generation) this.source.update((state) => { state.busy = false }) }
    })()
    this.operating = task
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task); if (this.operating === task) this.operating = undefined })
    return task
  }

  /** Clear private view material and stop polling on plugin unload. */
  async dispose(): Promise<void> {
    this.disposed = true
    ++this.generation
    clearInterval(this.timer)
    this.source.update((state) => { state.qr = null })
    await Promise.all([this.reading, ...this.pending])
  }
}
