/** More menu contribution and overlay, with effects owned by the plugin fiber. */
import type { Context } from '@deepseek-ai/cordis'
import { defineStore, type StoreHandle } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Config } from '../config.ts'
import { MobileDialog, MobileMenu, MobileTargetCard } from './MobileDialog.tsx'
import type { MobilePairingTarget } from '@deepseek-ai/dsh-api-mobile-controller/types'
import { MobileModel } from './model.ts'
import { en, zh, type MobileKey } from './locales.ts'
import { PhoneConnection } from './PhoneConnection.tsx'
import { phoneAdapter, type PhoneControl } from './phone.ts'

export { Config } from '../config.ts'
interface MobileView { open: boolean }
/**
 * Share one dialog visibility state between this plugin's menu and overlay.
 * @returns registration-owned, nonpersistent dialog visibility.
 */
export function createMobileViewStore(): StoreHandle<MobileView, { show: (draft: MobileView, open: boolean) => void }> {
  return defineStore({ init: () => ({ open: false }), actions: { show: (draft, open: boolean) => { draft.open = open } } })
}

/** Plain callbacks and a framework-bound source for one independently authorized target. */
export interface MobileFace {
  readonly target: MobilePairingTarget
  readonly hooks: { readonly mobile: MobileModel['source'] }
  readonly start: MobileModel['start']
  readonly stop: MobileModel['stop']
  readonly refresh: MobileModel['refresh']
  readonly showing: MobileModel['showing']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'mobile.remote': MobileKey }
  interface SlotMap {
    /** One independently consented browser or App pairing card in the desktop dialog. */
    'mobile.remote.dialog.target': { kind: 'keyed'; scope: 'root' }
  }
}

/** The browser has no relay or device credentials. */
export const inject = ['slots', 'locale', 'remote', 'remote.mobile']

/** @param ctx - desktop Client services. @param config - status polling policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  ctx.effect(() => ctx.locale.register('mobile.remote', { en, zh }), 'mobile: dictionaries')
  const control = (globalThis as { __DSH_TRANSPORT__?: { remoteControl?: PhoneControl } }).__DSH_TRANSPORT__?.remoteControl
  const phone = phoneAdapter(control)
  if (phone !== undefined) {
    ctx.effect(() => () => { phone.dispose() }, 'mobile: phone entry handoff')
    ctx.slots.inject('shell.navigation.actions', () => ctx.slots.register({
      name: 'shell.navigation.actions', id: 'mobile-connection', locale: 'mobile.remote', inject: () => phone.face,
    }, PhoneConnection))
    return
  }
  const mobile = ctx.remote.mobile
  const operations = {
    status: async (target: MobilePairingTarget) => {
      const result = await mobile.status(target); if (!result.ok) throw result.error; return result.value
    },
    start: async (request: Parameters<typeof mobile.start>[0]) => {
      const result = await mobile.start(request); if (!result.ok) throw result.error; return result.value
    },
    stop: async (target: MobilePairingTarget) => {
      const result = await mobile.stop(target); if (!result.ok) throw result.error; return result.value
    },
  }
  for (const target of ['browser', 'app'] as const) {
    const model = new MobileModel(operations, resolved.pollMs, target)
    ctx.effect(() => () => model.dispose(), `mobile: ${target} private QR and status polling`)
    const face: MobileFace = { target, hooks: { mobile: model.source }, start: () => model.start(),
      stop: () => model.stop(), refresh: () => model.refresh(), showing: (visible) => { model.showing(visible) } }
    ctx.slots.inject('mobile.remote.dialog.target', () => ctx.slots.register({
      name: 'mobile.remote.dialog.target', key: target, locale: 'mobile.remote', inject: () => face,
    }, MobileTargetCard))
  }
  const store = createMobileViewStore()
  ctx.slots.inject('settings.launcher.actions', () => ctx.slots.register({
    name: 'settings.launcher.actions', id: 'mobile-remote', locale: 'mobile.remote', store,
  }, MobileMenu))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'mobile-remote', locale: 'mobile.remote', store,
    children: { 'mobile.remote.dialog.target': { kind: 'keyed', scope: 'root' } },
  }, MobileDialog))
}
