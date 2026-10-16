/** Desktop authorization controls and the mobile capability protocol. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Identity retained for the whole authorization, including reconnects. */
export type MobileRequestId = Branded<'mobile-request-id'>
/** Browser generation authenticated inside every encrypted message. */
export type MobileChannelId = Branded<'mobile-channel-id'>

/** Selection made by the authenticated desktop operator. */
export interface MobileSessionStartRequest {
  readonly sessionId: SessionId
  readonly acknowledgeTools: true
  readonly allowWorkspaceRoaming?: boolean
}

/** Explicit whole-instance device consent; Session execution policies are unchanged. */
export type MobileStartRequest = MobileSessionStartRequest | { readonly scope: 'instance'; readonly acknowledgeTools: true }

/** Non-secret state safe to show after closing the QR dialog. */
export interface MobileDesktopState {
  readonly scope?: 'instance'
  readonly mobileOnline?: boolean
  readonly phase: 'disabled' | 'stopped' | 'starting' | 'waiting' | 'paired' | 'reconnecting' | 'expired' | 'failed'
  readonly sessionId: SessionId | null
  readonly title: string
  readonly expiresAt: number | null
  readonly ticketExpiresAt: number | null
  readonly relayRevoked: boolean
  readonly pairingUrl?: string | undefined
}

/** Private response to one operator gesture; never log or persist pairingUrl. */
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

/** Summary of one Session visible in mobile navigation. */
export interface MobileSessionSummary {
  readonly sessionId: SessionId
  readonly title: string
  readonly updatedAt: number
  readonly status: 'idle' | 'running' | 'desktop-input-required'
  readonly pinned?: boolean
}

/** Summary of one Workspace visible in mobile navigation. */
export interface MobileWorkspaceSummary {
  readonly workspaceId: string
  readonly name: string
  readonly sessions: readonly MobileSessionSummary[]
}

/** Structured rich content block for mobile conversation cards. */
export type MobileBlock =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'thinking'; readonly thinking: string }
  | { readonly type: 'tool_call'; readonly callId: string; readonly name: string; readonly args?: string | undefined }
  | { readonly type: 'tool_result'; readonly callId: string; readonly name: string; readonly summary?: string | undefined }

/** Rich message carrying formatted blocks. */
export interface MobileRichMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly blocks: readonly MobileBlock[]
}

/** Available model info exposed to mobile. */
export interface MobileModelItem {
  readonly id: string
  readonly name: string
  readonly provider: string
  readonly description?: string | undefined
}

/** Rich conversation snapshot with Markdown and tool cards. */
export interface MobileRichSnapshot {
  readonly sessionId: SessionId
  readonly title: string
  readonly status: 'idle' | 'running' | 'desktop-input-required'
  readonly messages: readonly MobileRichMessage[]
  readonly live: MobileRichMessage | null
  readonly truncated: boolean
  readonly currentPermissionMode?: 'plan' | 'build' | 'auto' | 'yolo' | undefined
  readonly currentModel?: { readonly provider: string; readonly model: string; readonly displayName?: string | undefined } | undefined
  readonly availableModels?: readonly MobileModelItem[] | undefined
}

/** Pending tool execution approval for mobile human-in-the-loop. */
export interface MobileApprovalItem {
  readonly id: string
  readonly toolName: string
  readonly description: string
  readonly riskLevel?: 'normal' | 'high' | undefined
}

/** Pending user question for mobile human-in-the-loop. */
export interface MobileQuestionItem {
  readonly id: string
  readonly question: string
  readonly header?: string | undefined
  readonly multiSelect?: boolean | undefined
  readonly options?: readonly { readonly label: string; readonly description?: string | undefined }[] | undefined
}

/** Mobile requests validated by exact field allowlists. */
export type MobileRequest =
  | { readonly type: 'hello'; readonly channel: MobileChannelId }
  | { readonly type: 'sync'; readonly channel: MobileChannelId }
  | { readonly type: 'send'; readonly channel: MobileChannelId; readonly id: MobileRequestId; readonly text: string; readonly sessionId?: SessionId }
  | { readonly type: 'receipt'; readonly channel: MobileChannelId; readonly id: MobileRequestId }
  | { readonly type: 'workspace:list'; readonly channel: MobileChannelId }
  | { readonly type: 'workspace:switch'; readonly channel: MobileChannelId; readonly workspaceId: string; readonly sessionId?: SessionId }
  | { readonly type: 'session:create'; readonly channel: MobileChannelId; readonly workspaceId?: string }
  | { readonly type: 'session:follow'; readonly channel: MobileChannelId; readonly sessionId: SessionId }
  | { readonly type: 'session:cancel'; readonly channel: MobileChannelId; readonly sessionId: SessionId }
  | { readonly type: 'session:rename'; readonly channel: MobileChannelId; readonly sessionId: SessionId; readonly title: string }
  | { readonly type: 'session:archive'; readonly channel: MobileChannelId; readonly sessionId: SessionId }
  | { readonly type: 'session:pin'; readonly channel: MobileChannelId; readonly sessionId: SessionId }
  | { readonly type: 'session:unpin'; readonly channel: MobileChannelId; readonly sessionId: SessionId }
  | { readonly type: 'session:permission'; readonly channel: MobileChannelId; readonly mode: 'plan' | 'build' | 'auto' | 'yolo' }
  | { readonly type: 'model:list'; readonly channel: MobileChannelId }
  | { readonly type: 'session:select_model'; readonly channel: MobileChannelId; readonly provider: string; readonly model: string }
  | { readonly type: 'approval:respond'; readonly channel: MobileChannelId; readonly requestId: string; readonly approved: boolean; readonly rationale?: string }
  | { readonly type: 'question:answer'; readonly channel: MobileChannelId; readonly questionId: string; readonly answers: Record<string, string> }

/** Admission is distinct from completion of the Agent's work. */
export type MobileReceiptStatus = 'accepted' | 'busy' | 'unknown' | 'not-seen' | 'limit' | 'conflict'

/** Replies are encrypted and bound to the browser's current generation. */
export type MobileReply =
  | { readonly type: 'state'; readonly channel: MobileChannelId; readonly revision: number; readonly expiresAt: number; readonly value: MobileSnapshot }
  | { readonly type: 'rich_state'; readonly channel: MobileChannelId; readonly revision: number; readonly expiresAt: number; readonly value: MobileRichSnapshot }
  | { readonly type: 'workspace:state'; readonly channel: MobileChannelId; readonly revision: number; readonly workspaces: readonly MobileWorkspaceSummary[]; readonly activeWorkspaceId?: string; readonly activeSessionId?: SessionId }
  | { readonly type: 'model:catalog'; readonly channel: MobileChannelId; readonly models: readonly MobileModelItem[] }
  | { readonly type: 'permission:state'; readonly channel: MobileChannelId; readonly mode: 'plan' | 'build' | 'auto' | 'yolo' }
  | { readonly type: 'approval:active'; readonly channel: MobileChannelId; readonly pending: readonly MobileApprovalItem[] }
  | { readonly type: 'question:active'; readonly channel: MobileChannelId; readonly pending: readonly MobileQuestionItem[] }
  | { readonly type: 'receipt'; readonly channel: MobileChannelId; readonly id: MobileRequestId; readonly status: MobileReceiptStatus }
