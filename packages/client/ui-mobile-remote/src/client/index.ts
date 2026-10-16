/** More menu contribution and overlay, with effects owned by the plugin fiber. */
import type { Context } from '@deepseek-ai/cordis'
import { defineStore, type StoreHandle } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-account/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { Config } from '../config.ts'
import { MobileDialog, MobileMenu } from './MobileDialog.tsx'
import { MobileModel } from './model.ts'
import { en, zh, type MobileKey } from './locales.ts'

export { Config } from '../config.ts'
interface MobileView { open: boolean }
/**
 * Share one dialog visibility state between this plugin's menu and overlay.
 * @returns registration-owned, nonpersistent dialog visibility.
 */
export function createMobileViewStore(): StoreHandle<MobileView, { show: (draft: MobileView, open: boolean) => void }> {
  return defineStore({ init: () => ({ open: false }), actions: { show: (draft, open: boolean) => { draft.open = open } } })
}

/** Plain callbacks and a framework-bound authorization source. */
export interface MobileFace {
  readonly hooks: { readonly mobile: MobileModel['source'] }
  readonly start: MobileModel['start']
  readonly stop: MobileModel['stop']
  readonly refresh: MobileModel['refresh']
  readonly showing: MobileModel['showing']
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'mobile.remote': MobileKey }
}

/** The browser has no relay or device credentials. */
export const inject = ['slots', 'locale', 'remote', 'remote.mobile']

/** @param ctx - desktop Client services. @param config - status polling policy. */
export function apply(ctx: Context, config: Config): void {
  const resolved = Config(config)
  ctx.effect(() => ctx.locale.register('mobile.remote', { en, zh }), 'mobile: dictionaries')
  const mobile = ctx.remote.mobile
  const model = new MobileModel({
    status: async () => { const result = await mobile.status(); if (!result.ok) throw result.error; return result.value },
    start: async (request) => { const result = await mobile.start(request); if (!result.ok) throw result.error; return result.value },
    stop: async () => { const result = await mobile.stop(); if (!result.ok) throw result.error; return result.value },
  }, resolved.pollMs)
  ctx.effect(() => () => model.dispose(), 'mobile: private QR and status polling')
  const store = createMobileViewStore()
  const face: MobileFace = { hooks: { mobile: model.source }, start: request => model.start(request),
    stop: () => model.stop(), refresh: () => model.refresh(), showing: (visible) =>{  model.showing(visible) } }
  ctx.slots.inject('settings.launcher.actions', () => ctx.slots.register({
    name: 'settings.launcher.actions', id: 'mobile-remote', locale: 'mobile.remote', store, inject: () => face,
  }, MobileMenu))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'mobile-remote', locale: 'mobile.remote', store, inject: () => face,
  }, MobileDialog))
}
