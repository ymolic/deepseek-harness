/** One declaration and render site shared by every settings launcher menu. */
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/** @param props - menu dismissal callback and authorized action renderer. @returns contributed menu rows. */
export function SettingsLauncherActions({ onDismiss, renderSlot }: FactoryComponentPropsOf<'settings.launcher.actions'>) {
  return renderSlot('settings.launcher.actions', { onDismiss })
}
