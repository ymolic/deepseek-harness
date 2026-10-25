/** Independent browser and App consent cards render Host-issued pairing URLs without rewriting them. */
import { useEffect, useId, useState } from 'react'
import { Button, Checkbox, MenuItemButton, Modal, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { MobileFace, createMobileViewStore } from './index.ts'
import css from './MobileDialog.module.css'

type Shared = PropsLocale<'mobile.remote'> & PropsStore<ReturnType<typeof createMobileViewStore>>
type DialogProps = PropsRuntime<'shell.overlay'> & Shared & PropsRenderSlots<'mobile.remote.dialog.target'>
type TargetProps = PropsRuntime<'mobile.remote.dialog.target'> & PropsLocale<'mobile.remote'> & InjectFace<MobileFace>

/** @param props - menu owner and shared dialog visibility. @returns one standard More menu row. */
export function MobileMenu({ onDismiss, actions, t }: PropsRuntime<'settings.launcher.actions'> & Shared) {
  return <MenuItemButton icon={<IconLinkOutlineRegular size={16} />} onSelect={() => { onDismiss(); actions.show(true) }}>{t('title')}</MenuItemButton>
}

/** @param props - framework-owned visibility and child renderers. @returns the nonpersistent QR dialog. */
export function MobileDialog({ useStore, actions, renderSlot, t }: DialogProps) {
  const open = useStore(state => state.open)
  return <Modal open={open} onClose={() => { actions.show(false) }} title={t('title')} closeLabel={t('close')}
    {...(css.dialog ? { className: css.dialog } : {})} footer={<div className={css.actions}>
      <Button onClick={() => { actions.show(false) }}>{t('close')}</Button>
    </div>}>
    <div className={css.body}>
      <p>{t('independent')}</p>
      <p>{t('tools')}</p>
      <div className={css.cards}>
        {renderSlot('mobile.remote.dialog.target', {}, { entryKey: 'browser' })}
        {renderSlot('mobile.remote.dialog.target', {}, { entryKey: 'app' })}
      </div>
      <p>{t('scope')}</p><p>{t('privacy')}</p><p>{t('keep')}</p>
    </div>
  </Modal>
}

/** @param props - one target's framework-bound source and restricted Host callbacks. @returns an independently controlled card. */
export function MobileTargetCard({ target, useMobile, start, stop, refresh, showing, t }: TargetProps) {
  const mobile = useMobile(state => state)
  const heading = useId()
  const [acknowledged, setAcknowledged] = useState(false)
  useEffect(() => { showing(true); return () => { showing(false) } }, [showing])
  const active = mobile.state && ['starting', 'waiting', 'paired', 'reconnecting'].includes(mobile.state.phase)
  const paired = mobile.state?.phase === 'paired'
  const request = () => { setAcknowledged(false); void start() }
  return <section className={css.card} aria-labelledby={heading} aria-busy={mobile.busy} data-mobile-pairing-target={target}>
    <h3 className={css.heading} id={heading}>{t(`target.${target}`)}</h3>
    <p>{t(`scan.${target}`)}</p>
    <p className={css.status} role="status">{t(mobile.busy ? 'working' : mobile.state?.phase ?? 'starting')}</p>
    {paired && <p>{t(mobile.state?.mobileOnline ? 'online' : 'offline')}</p>}
    {!paired && mobile.qr && <div className={css.qr}>
      <img src={mobile.qr} width={300} height={300} alt={t(`qr.${target}`)} />
    </div>}
    {!mobile.busy && !mobile.qr && mobile.state?.phase === 'waiting' && <p>{t('ticketExpired')}</p>}
    {mobile.state?.phase !== 'disabled' && <>
      {active && <p>{t('refreshHint')}</p>}
      <Checkbox checked={acknowledged} onChange={setAcknowledged} label={t(`consent.${target}`)} disabled={mobile.busy} />
      <Button variant="primary" disabled={!acknowledged || mobile.busy} onClick={request}>{t(active ? 'refresh' : 'authorize')}</Button>
    </>}
    {(active || mobile.busy || mobile.state?.relayRevoked === false) && <Button variant="outline" onClick={() => { void stop() }}>{t('stop')}</Button>}
    {mobile.state?.relayRevoked === false && !active && <p role="alert">{t('revokeUnknown')}</p>}
    {mobile.failed && <div className={css.failure} role="alert">
      <p>{t('error')}</p>
      <Button variant="outline" disabled={mobile.busy} onClick={() => { void refresh() }}>{t('retry')}</Button>
    </div>}
  </section>
}
