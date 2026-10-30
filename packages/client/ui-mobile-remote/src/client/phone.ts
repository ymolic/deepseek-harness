/** Optional phone-shell controls carried by the existing trusted transport. */
export interface PhoneState {
  readonly phase: 'connected' | 'connecting' | 'offline' | 'unavailable' | 'pairing' | 'replaced' | 'revoking' | 'revoke-unconfirmed'
  readonly canReconnect: boolean
  readonly canForget: boolean
}

/** Known deployment kind of one native instance target. */
export type NativeInstanceKind = 'local' | 'cloud'

/** Declared native instance available for selection. */
export interface NativeInstanceItem {
  readonly id: string
  readonly label: string
  readonly kind: NativeInstanceKind
}

/** Injected native instances payload format v1. */
export interface NativeInstancesPayload {
  readonly version: 1
  readonly activeId: string
  readonly instances: readonly NativeInstanceItem[]
}

/** Payload sent to the native bridge when requesting an instance switch. */
export interface SwitchInstanceRequest {
  readonly targetId: string
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
  /**
   * Request native instance switch.
   * @param request - target instance identifier or request payload.
   */
  switchInstance?(request: SwitchInstanceRequest | string): void
  /** Injected native instances metadata, if supplied by this carrier. */
  readonly instances?: unknown
}

/**
 * Read and validate native instance metadata from bridge injection or a candidate object.
 * @param source - candidate payload; defaults to `globalThis.__DSH_NATIVE_INSTANCES__`.
 * @returns validated instances payload, or undefined when missing or malformed.
 */
export function readNativeInstances(source?: unknown): NativeInstancesPayload | undefined {
  const raw = source ?? (globalThis as { __DSH_NATIVE_INSTANCES__?: unknown }).__DSH_NATIVE_INSTANCES__
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Record<string, unknown>
  if (candidate.version !== 1) return undefined
  if (typeof candidate.activeId !== 'string' || candidate.activeId.length === 0) return undefined
  if (!Array.isArray(candidate.instances) || candidate.instances.length === 0) return undefined

  const seenIds = new Set<string>()
  const parsedInstances: NativeInstanceItem[] = []
  for (const item of candidate.instances) {
    if (typeof item !== 'object' || item === null) return undefined
    const row = item as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0) return undefined
    if (typeof row.label !== 'string' || row.label.length === 0) return undefined
    if (row.kind !== 'local' && row.kind !== 'cloud') return undefined
    if (seenIds.has(row.id)) return undefined
    seenIds.add(row.id)
    parsedInstances.push({
      id: row.id,
      label: row.label,
      kind: row.kind,
    })
  }

  if (!seenIds.has(candidate.activeId)) return undefined

  return {
    version: 1,
    activeId: candidate.activeId,
    instances: parsedInstances,
  }
}

/**
 * Dispatch an instance switch request to the native shell via available communication points.
 * @param targetId - identifier of the target instance to switch to.
 * @param control - optional active phone control holding native callbacks.
 */
export function dispatchNativeSwitchInstance(targetId: string, control?: PhoneControl): void {
  const payload: SwitchInstanceRequest = { targetId }
  let handled = false
  if (typeof control?.switchInstance === 'function') {
    try {
      control.switchInstance(payload)
      handled = true
    } catch {
      // Suppress callback failure
    }
  }

  if (!handled) {
    const webkit = (globalThis as {
      webkit?: {
        messageHandlers?: Record<string, { postMessage: (message: unknown) => void }>
      }
    }).webkit

    if (webkit?.messageHandlers?.switchInstance?.postMessage) {
      try {
        webkit.messageHandlers.switchInstance.postMessage(payload)
      } catch {
        // Suppress message handler exceptions
      }
    } else if (webkit?.messageHandlers?.dsh?.postMessage) {
      try {
        webkit.messageHandlers.dsh.postMessage({ action: 'switchInstance', ...payload })
      } catch {
        // Suppress message handler exceptions
      }
    }
  }
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
      get instances(): NativeInstancesPayload | undefined {
        return readNativeInstances(control.instances)
      },
      switchInstance: (targetId: string): void => {
        if (!disposed) dispatchNativeSwitchInstance(targetId, control)
      },
    },
    dispose: (): void => { disposed = true; release?.(); release = undefined },
  }
}

/** Registration-derived, restricted phone callbacks and state. */
export type PhoneFace = NonNullable<ReturnType<typeof phoneAdapter>>['face']
