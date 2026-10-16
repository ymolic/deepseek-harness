/** Instance consent and transient, locally generated pairing QR view. */
import { useEffect, useState } from 'react'
import { Button, Checkbox, MenuItemButton, Modal, IconLinkOutlineRegular, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MobileFace, createMobileViewStore } from './index.ts'
import css from './MobileDialog.module.css'

type Shared = PropsLocale<'mobile.remote'> & PropsStore<ReturnType<typeof createMobileViewStore>> & InjectFace<MobileFace>
/** @param props - menu owner, shared view state and authorization model. @returns one standard More menu row. */
export function MobileMenu({ onDismiss, actions, t }: PropsRuntime<'settings.launcher.actions'> & Shared) {
  return <MenuItemButton icon={<IconLinkOutlineRegular size={16} />} onSelect={() => { onDismiss(); actions.show(true) }}>{t('title')}</MenuItemButton>
}

/** @param props - framework-owned sources, view actions and Host callbacks. @returns the nonpersistent QR dialog. */
export function MobileDialog({ useStore, actions, useMobile, start, stop, refresh, showing, t }: PropsRuntime<'shell.overlay'> & Shared) {
  const open = useStore(state => state.open)
  const mobile = useMobile(state => state)
  const [acknowledged, setAcknowledged] = useState(false)
  const [showFailure, setShowFailure] = useState(false)
  useEffect(() => { showing(open); return () => { showing(false) } }, [open, showing])
  useEffect(() => { if (mobile.failed) setShowFailure(true) }, [mobile.failed])
  const active = mobile.state && ['starting', 'waiting', 'paired', 'reconnecting'].includes(mobile.state.phase)
  const paired = mobile.state?.phase === 'paired'
  const request = () => { void start({ scope: 'instance', acknowledgeTools: true }) }
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
          <p>{t('tools')}</p>
          <Checkbox checked={acknowledged} onChange={setAcknowledged} label={t('consent')} disabled={mobile.busy} />
          <Button variant="primary" disabled={!acknowledged || mobile.busy} onClick={request}>{t('authorize')}</Button>
        </>}
        {active && <>
          {paired && <p>{t(mobile.state?.mobileOnline ? 'online' : 'offline')}</p>}
          {!paired && mobile.qr && <div className={css.qr}><img src={mobile.qr} width={300} height={300} alt={t('qr')} /><p>{t('scan')}</p></div>}
          {!mobile.qr && mobile.state?.phase === 'waiting' && <p>{t('ticketExpired')}</p>}
          {!paired && <><Button variant="outline" disabled={mobile.busy} onClick={request}>{t('refresh')}</Button><p>{t('refreshHint')}</p></>}
        </>}
        {mobile.state?.relayRevoked === false && !active && <p role="alert">{t('revokeUnknown')}</p>}
        {mobile.failed && <Button variant="outline" onClick={() => { void refresh() }}>{t('retry')}</Button>}
        <p>{t('scope')}</p><p>{t('privacy')}</p><p>{t('keep')}</p>
      </div>
    </Modal>
  </>
}
