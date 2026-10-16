/** Sidebar reopen and New Session controls for the frame's shell.leading seat. */
import {
  focusWithoutRing, IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the frame's shell.leading slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarRootInjected } from './contract/slots.ts'
import css from './HeaderLeadingControls.module.css'

/** Full props of the shell.leading occupant. */
export type HeaderLeadingControlsProps =
  PropsRuntime<'shell.leading'>
  & InjectFace<SidebarRootInjected>
  & PropsLocale<'sidebar'>

/**
 * Sidebar-open and New Session controls in the frame's window-chrome seat.
 * The frame places these controls in phone navigation or beside macOS traffic
 * lights when the sidebar is hidden. Its modal drawer covers this seat while open.
 * @param props - Injected sidebar actions plus the sidebar locale seat.
 * @returns the two window-chrome controls.
 */
export function HeaderLeadingControls({ toggleSidebar, startSession, useShortcuts, t }: HeaderLeadingControlsProps) {
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  return (
    <div className={css.controls}>
      <Tooltip label={t('toggle.open')} shortcutKeys={shortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('toggle.open')}
          aria-keyshortcuts={shortcut?.aria}
          onClick={(event) => {
            // Touch WebKit does not focus buttons before the drawer captures its return target.
            if (document.activeElement !== event.currentTarget) focusWithoutRing(event.currentTarget)
            toggleSidebar()
          }}
        >
          <IconPanelLeftOutlineRegular size={16} />
        </button>
      </Tooltip>
      <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500}>
        <button
          type="button"
          className={css.iconButton}
          aria-label={t('session.new.label')}
          aria-keyshortcuts={newShortcut?.aria}
          onClick={() => { startSession() }}
        >
          <IconNewChatOutlineRegular size={16} />
        </button>
      </Tooltip>
    </div>
  )
}
