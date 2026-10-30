/** Load Desktop account UI without downloading its artwork in ordinary browsers. */
import type { Context } from '@deepseek-ai/cordis'
import type { AccountKey } from './locales.ts'
export type { AccountSectionInjected, AccountSectionProps, AccountSnapshot } from './AccountSection.tsx'
export type { AccountMenuProps } from './AccountMenu.tsx'
export type { AccountKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.account': AccountKey }
}

/** Services required by account settings. */
export const inject = ['slots', 'locale', 'remote', 'remote.account', 'remote.session', 'theme', 'configForms', 'remoteAccess']

/**
 * Activate account UI only after the Desktop-only module loads.
 * @param ctx - client plugin context; unloading prevents late registration.
 * @returns completion of account registration; module failures reach the Loader.
 */
export async function apply(ctx: Context): Promise<void> {
  if (!('dshDesktop' in globalThis)) return
  const lifetime = { disposed: false }
  ctx.effect(() => () => { lifetime.disposed = true }, 'account: module load lifetime')
  const desktop = await import('./desktop.ts')
  if (!lifetime.disposed) desktop.apply(ctx)
}
