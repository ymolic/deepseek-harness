/** Desktop Session consent and transient, locally generated pairing QR view. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, Menu, MenuItemButton, Modal, IconLinkOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileFace, createMobileViewStore } from './index.ts'
import css from './MobileDialog.module.css'

type Shared = PropsLocale<'mobile.remote'> & PropsStore<ReturnType<typeof createMobileViewStore>> & InjectFace<MobileFace>
/** @param props - menu owner, shared view state and authorization model. @returns one standard More menu row. */
export function MobileMenu({ onDismiss, actions, t }: PropsRuntime<'settings.launcher.actions'> & Shared) {
  return <MenuItemButton icon={<IconLinkOutlineRegular size={16} />} onSelect={() => { onDismiss(); actions.show(true) }}>{t('title')}</MenuItemButton>
}

/** @param props - framework-owned sources, view actions and Host callbacks. @returns the nonpersistent QR dialog. */
export function MobileDialog({ useStore, actions, useMobile, useSessions, start, stop, refresh, showing, t }: PropsRuntime<'shell.overlay'> & Shared) {
  const open = useStore(state => state.open)
  const mobile = useMobile(state => state)
  const catalog = useSessions(state => state)
  const [selection, setSelection] = useState<SessionId>()
  const [acknowledged, setAcknowledged] = useState(false)
  const [picker, setPicker] = useState(false)
  const [showFailure, setShowFailure] = useState(false)
  useEffect(() => { showing(open); return () => { showing(false) } }, [open, showing])
  useEffect(() => { if (mobile.failed) setShowFailure(true) }, [mobile.failed])
  const active = mobile.state && ['starting', 'waiting', 'paired', 'reconnecting'].includes(mobile.state.phase)
  const candidates = catalog.ids.flatMap((id) => { const row = catalog.byId[id]; return row && row.origin !== 'subagent' ? [row] : [] })
  const chosen = selection === undefined ? undefined : catalog.byId[selection]
  const remaining = Math.max(0, Math.ceil(((mobile.state?.expiresAt ?? 0) - mobile.now) / 1000))
  const request = (sessionId: SessionId) => { void start({ sessionId, acknowledgeTools: true }) }
  return <>
    {showFailure && <Toast text={t('error')} onDone={() => { setShowFailure(false) }} />}
    <Modal open={open} onClose={() => { actions.show(false) }} title={t('title')} closeLabel={t('close')}
      {...(css.dialog ? { className: css.dialog } : {})} footer={<div className={css.actions}>
        {(active || mobile.busy || mobile.state?.relayRevoked === false) && <Button variant="outline" onClick={() => { void stop() }}>{t('stop')}</Button>}
        <Button onClick={() => { actions.show(false) }}>{t('close')}</Button>
      </div>}>
      <div className={css.body}>
        <p className={css.status} role="status">{t(mobile.state?.phase ?? 'starting')}</p>
        {!active && mobile.state?.phase !== 'disabled' && <>
          <Menu open={picker} portal items={candidates.map(row => ({ id: row.id, label: row.displayTitle }))}
            selectedId={selection} onClose={() => { setPicker(false) }}
            onSelect={(id) => {
              const row = candidates.find(candidate => candidate.id === id)
              if (row) setSelection(row.id)
              setAcknowledged(false); setPicker(false)
            }}
            anchor={<Button variant="outline" disabled={mobile.busy || candidates.length === 0} onClick={() => { setPicker(value => !value) }}>
              {chosen?.displayTitle ?? t(candidates.length === 0 ? 'empty' : 'select')}
            </Button>} />
          {chosen?.cwd && <p className={css.path}>{chosen.cwd}</p>}
          <p>{t('tools')}</p>
          <Checkbox checked={acknowledged} onChange={setAcknowledged} label={t('consent')} disabled={mobile.busy} />
          <Button variant="primary" disabled={!selection || !acknowledged || mobile.busy} onClick={() => { if (selection) request(selection) }}>{t('authorize')}</Button>
        </>}
        {active && <>
          <p className={css.session}>{mobile.state?.title}</p>
          <p>{t('remaining')}: {remaining} {t('seconds')}</p>
          {mobile.qr && <div className={css.qr}><img src={mobile.qr} width={300} height={300} alt={t('qr')} /><p>{t('scan')}</p></div>}
          {!mobile.qr && mobile.state?.phase === 'waiting' && <p>{t('ticketExpired')}</p>}
          <Button variant="outline" disabled={mobile.busy} onClick={() => { if (mobile.state?.sessionId) request(mobile.state.sessionId) }}>{t('refresh')}</Button>
          <p>{t('refreshHint')}</p>
        </>}
        {mobile.state?.relayRevoked === false && !active && <p role="alert">{t('revokeUnknown')}</p>}
        {mobile.failed && <Button variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button>}
        <p>{t('scope')}</p><p>{t('privacy')}</p><p>{t('keep')}</p>
      </div>
    </Modal>
  </>
}
