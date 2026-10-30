/** Navigation status and connection management for this phone, not desktop enrollment. */
import { useState } from 'react'
import {
  Button, Modal, StateDot, focusWithoutRing, IconCheckOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronRightOutlineRegular, IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readNativeInstances, type PhoneFace, type PhoneState } from './phone.ts'
import css from './PhoneConnection.module.css'

type Props = PropsRuntime<'shell.navigation.actions'> & PropsLocale<'mobile.remote'> & InjectFace<PhoneFace>

const tones = {
  connected: 'done', connecting: 'ongoing', offline: 'warning', unavailable: 'error',
  pairing: 'warning', replaced: 'warning', revoking: 'ongoing', 'revoke-unconfirmed': 'error',
} as const satisfies Record<PhoneState['phase'], string>

/**
 * Minimalist monitor/desktop glyph matching DSH sidebar icon line language.
 * @param props - rendered box dimension.
 * @returns vector monitor glyph on currentColor.
 */
export function LocalIcon({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="instance-icon-local"
    >
      <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
      <path d="M5 14.5H11" />
      <path d="M8 11.5V14.5" />
    </svg>
  )
}

/**
 * Minimalist cloud glyph matching DSH sidebar icon line language.
 * @param props - rendered box dimension.
 * @returns vector cloud glyph on currentColor.
 */
export function CloudIcon({ size = 14 }: { readonly size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-testid="instance-icon-cloud"
    >
      <path d="M4.5 12.5h7a2.5 2.5 0 0 0 .5-4.95 3.5 3.5 0 0 0-6.7-1.3 2.75 2.75 0 0 0-3.3 3.75A2.5 2.5 0 0 0 4.5 12.5Z" />
    </svg>
  )
}

/** @param props - shell state and restricted actions. @returns a status button and modal bottom panel. */
export function PhoneConnection({ usePhone, entryRef, reconnect, forget, t, instances, switchInstance }: Props) {
  const state = usePhone(value => value)
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const close = () => { setConfirming(false); setOpen(false) }
  const label = t(`phone.${state.phase}`)

  const activeInstances = instances ?? readNativeInstances()
  const activeInstance = activeInstances?.instances.find(item => item.id === activeInstances.activeId)
  const activeIcon = activeInstance !== undefined ? (
    <span className={css.instanceIcon} aria-hidden="true" data-testid="instance-kind-icon" data-instance-kind={activeInstance.kind}>
      {activeInstance.kind === 'cloud' ? <CloudIcon size={14} /> : <LocalIcon size={14} />}
    </span>
  ) : null

  return <>
    <Button ref={entryRef} className={css.trigger} aria-label={`${t('phoneTitle')}: ${label}`}
      aria-haspopup="dialog" aria-expanded={open}
      onClick={(event) => { focusWithoutRing(event.currentTarget); setOpen(true) }}>
      {activeIcon}
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
        {activeInstances !== undefined && activeInstances.instances.length > 0 && (
          <div className={css.instancesSection} data-testid="instances-section">
            <div className={css.sectionHeading}>{t('phoneInstances')}</div>
            <div className={css.instanceList} role="menu">
              {activeInstances.instances.map((item) => {
                const isActive = item.id === activeInstances.activeId
                return (
                  <Button
                    key={item.id}
                    role="menuitem"
                    aria-current={isActive ? 'true' : undefined}
                    className={`${css.instanceRow}${isActive ? ` ${css.instanceRowActive}` : ''}`}
                    onClick={() => {
                      if (!isActive) {
                        switchInstance(item.id)
                      }
                      close()
                    }}
                  >
                    <span className={css.instanceRowKindIcon} aria-hidden="true">
                      {item.kind === 'cloud' ? <CloudIcon size={16} /> : <LocalIcon size={16} />}
                    </span>
                    <span className={css.instanceRowLabel}>{item.label}</span>
                    {isActive && <IconCheckOutlineRegular size={16} className={css.instanceCheck} />}
                  </Button>
                )
              })}
            </div>
          </div>
        )}
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
