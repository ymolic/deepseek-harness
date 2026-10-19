/** Optional phone-shell controls carried by the existing trusted transport. */
export interface PhoneState {
  readonly phase: 'connected' | 'connecting' | 'offline' | 'unavailable' | 'pairing' | 'replaced' | 'revoking' | 'revoke-unconfirmed'
  readonly canReconnect: boolean
  readonly canForget: boolean
}

/** The outer shell owns connectivity, admission and revocation outcomes. */
export interface PhoneControl {
  /** @returns identity-stable state until the shell publishes a change. */
  getSnapshot(): PhoneState
  /** @param listener - invalidation callback. @returns listener cleanup. */
  subscribe(listener: () => void): () => void
  /** @param element - mounted navigation button. @returns handoff cleanup. */
  registerEntry(element: HTMLButtonElement): () => void
  /** Reconnect without replacing a mounted application or replaying writes. */
  reconnect(): void
  /** Revoke after UI confirmation; uncertain outcomes remain in the source. */
  forget(): Promise<void>
}

/**
 * Bind a single navigation entry to its plugin lifetime, without mirroring shell state.
 * @param control - optional capability; old relays and ordinary clients omit it.
 * @returns callbacks and observable for registration, or undefined without the capability.
 */
export function phoneAdapter(control: PhoneControl | undefined) {
  if (control === undefined) return undefined
  let release: (() => void) | undefined
  let disposed = false
  return {
    face: {
      hooks: { phone: { getSnapshot: () => control.getSnapshot(), subscribe: (listener: () => void) => control.subscribe(listener) } },
      entryRef: (element: HTMLButtonElement | null): void => {
        release?.()
        release = undefined
        if (!disposed && element !== null) release = control.registerEntry(element)
      },
      reconnect: (): void => { if (!disposed) control.reconnect() },
      forget: (): void => { if (!disposed) void control.forget() },
    },
    dispose: (): void => { disposed = true; release?.(); release = undefined },
  }
}

/** Registration-derived, restricted phone callbacks and state. */
export type PhoneFace = NonNullable<ReturnType<typeof phoneAdapter>>['face']
