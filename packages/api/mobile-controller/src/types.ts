/** Desktop authorization controls and the deliberately small mobile text protocol. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity retained for the whole authorization, including reconnects. */
export type MobileRequestId = Branded<'mobile-request-id'>
/** Browser generation authenticated inside every encrypted message. */
export type MobileChannelId = Branded<'mobile-channel-id'>

/** Selection made by the authenticated desktop operator. */
export interface MobileStartRequest {
  readonly sessionId: SessionId
  readonly acknowledgeTools: true
}

/** Non-secret state safe to show after closing the QR dialog. */
export interface MobileDesktopState {
  readonly phase: 'disabled' | 'stopped' | 'starting' | 'waiting' | 'paired' | 'reconnecting' | 'expired' | 'failed'
  readonly sessionId: SessionId | null
  readonly title: string
  readonly expiresAt: number | null
  readonly ticketExpiresAt: number | null
  readonly relayRevoked: boolean
}

/** Private response to one desktop gesture; never log or persist pairingUrl. */
export interface MobileStartResult {
  readonly pairingUrl: string
  readonly state: MobileDesktopState
}

/** A display-only text excerpt; no tool output, reasoning, prompt, or filesystem metadata. */
export interface MobileText {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
}

/** Bounded replacement snapshot, independent of transport-frame delivery. */
export interface MobileSnapshot {
  readonly title: string
  readonly status: 'idle' | 'running' | 'desktop-input-required'
  readonly messages: readonly MobileText[]
  readonly live: MobileText | null
  readonly truncated: boolean
}

/** Mobile requests have no session, path, permission, or generic RPC field. */
export type MobileRequest =
  | { readonly type: 'hello'; readonly channel: MobileChannelId }
  | { readonly type: 'sync'; readonly channel: MobileChannelId }
  | { readonly type: 'send'; readonly channel: MobileChannelId; readonly id: MobileRequestId; readonly text: string }
  | { readonly type: 'receipt'; readonly channel: MobileChannelId; readonly id: MobileRequestId }

/** Admission is distinct from completion of the Agent's work. */
export type MobileReceiptStatus = 'accepted' | 'busy' | 'unknown' | 'not-seen' | 'limit' | 'conflict'

/** Replies are encrypted and bound to the browser's current generation. */
export type MobileReply =
  | { readonly type: 'state'; readonly channel: MobileChannelId; readonly revision: number; readonly expiresAt: number; readonly value: MobileSnapshot }
  | { readonly type: 'receipt'; readonly channel: MobileChannelId; readonly id: MobileRequestId; readonly status: MobileReceiptStatus }
