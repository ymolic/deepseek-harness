/** Navigation status and connection management for this phone, not desktop enrollment. */
import { useState } from 'react'
import {
  Button, Modal, StateDot, focusWithoutRing, IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { PhoneFace, PhoneState } from './phone.ts'
import css from './PhoneConnection.module.css'

type Props = PropsRuntime<'shell.navigation.actions'> & PropsLocale<'mobile.remote'> & InjectFace<PhoneFace>

const tones = {
  connected: 'done', connecting: 'ongoing', offline: 'warning', unavailable: 'error',
  pairing: 'warning', replaced: 'warning', revoking: 'ongoing', 'revoke-unconfirmed': 'error',
} as const satisfies Record<PhoneState['phase'], string>

/** @param props - shell state and restricted actions. @returns a status button and modal bottom panel. */
export function PhoneConnection({ usePhone, entryRef, reconnect, forget, t }: Props) {
  const state = usePhone(value => value)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const close = () => { setConfirming(false); setOpen(false) }
  const label = t(`phone.${state.phase}`)
  return <>
    <Button ref={entryRef} className={css.trigger} aria-label={`${t('phoneTitle')}: ${label}`}
      aria-haspopup="dialog" aria-expanded={open}
      onClick={(event) => { focusWithoutRing(event.currentTarget); setOpen(true) }}>
      <StateDot state={tones[state.phase]} />
      <span className={css.label} aria-live="polite">{label}</span>
      <IconChevronDownOutlineRegular size={14} />
    </Button>
    <Modal open={open} onClose={close} title={t('phoneTitle')} headless className={css.sheet as string}>
      <div className={css.header}>
        <h2>{t('phoneTitle')}</h2>
        <Button className={css.touch} aria-label={t('close')} data-modal-autofocus onClick={close}>
          <IconCloseOutlineRegular size={16} />
        </Button>
      </div>
      <div className={css.body}>
        <p className={css.status} role="status"><StateDot state={tones[state.phase]} />{label}</p>
        <p>{t(`phone.reason.${state.phase}`)}</p>
        {state.canReconnect && <Button variant="outline" className={css.touch} onClick={reconnect}>{t('phoneReconnect')}</Button>}
        <div className={css.danger}>
          <Button className={css.forget} disabled={!state.canForget}
            onClick={(event) => { focusWithoutRing(event.currentTarget); setConfirming(true) }}>
            {t('phoneForget')}<IconChevronRightOutlineRegular size={16} />
          </Button>
        </div>
      </div>
    </Modal>
    <Modal open={open && confirming} onClose={() => { setConfirming(false) }}
      title={t('phoneForgetTitle')} closeLabel={t('close')}
      footer={<>
        <Button className={css.touch} data-modal-autofocus onClick={() => { setConfirming(false) }}>{t('phoneCancel')}</Button>
        <Button variant="outline" className={css.touch} disabled={!state.canForget}
          onClick={() => { setConfirming(false); forget() }}>{t('phoneConfirm')}</Button>
      </>}>
      <p>{t('phoneForgetDescription')}</p>
    </Modal>
  </>
}
