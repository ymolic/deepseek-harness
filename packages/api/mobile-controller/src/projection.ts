/** Bounded phone excerpts from the existing Session follow stream. */
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { isRecord } from './protocol.ts'
import type { MobileApprovalItem, MobileBlock, MobileModelItem, MobileQuestionItem, MobileRichMessage, MobileRichSnapshot, MobileSnapshot, MobileText } from './types.ts'

function textContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return ''
  return value.content.flatMap((part: unknown) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? [part.text] : []).join('')
}

function extractBlocks(value: unknown): MobileBlock[] {
  if (!isRecord(value) || !Array.isArray(value.content)) return []
  const blocks: MobileBlock[] = []
  for (const part of value.content) {
    if (!isRecord(part)) continue
    if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.length > 0) {
      blocks.push({ type: 'thinking', thinking: part.thinking })
    }
  }
  return blocks
}

function bounded(text: string, bytes: number): string {
  const encoded = Buffer.from(text)
  if (encoded.length <= bytes) return text
  return new TextDecoder().decode(encoded.subarray(0, bytes - 3)).replace(/\uFFFD$/, '') + '…'
}

function formatToolArgs(_name: string, raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw === 'string') return bounded(raw, 1000)
  if (isRecord(raw)) {
    if (typeof raw.command === 'string') return bounded(raw.command, 500)
    if (typeof raw.file_path === 'string') return bounded(raw.file_path, 300)
    if (typeof raw.path === 'string') return bounded(raw.path, 300)
    if (typeof raw.pattern === 'string') return bounded(`pattern: ${raw.pattern}`, 300)
    if (typeof raw.query === 'string') return bounded(raw.query, 300)
    if (Array.isArray(raw.queries)) return bounded(raw.queries.join(', '), 300)
    if (typeof raw.url === 'string') return bounded(raw.url, 300)
    return bounded(JSON.stringify(raw), 1000)
  }
  return bounded(typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : (JSON.stringify(raw) || ''), 500)
}

/** Keeps only recent user/assistant text; every frame is a full replacement. */
export class MobileProjection {
  private messages: MobileText[] = []
  private live: MobileText | null = null
  private richMessages: MobileRichMessage[] = []
  private liveRich: MobileRichMessage | null = null
  private truncated = false
  private readonly waiting = new Set<string>()
  private readonly pendingApprovals = new Map<string, MobileApprovalItem>()
  private readonly pendingQuestions = new Map<string, MobileQuestionItem>()

  /** @param maxHistoryBytes - total serialized text budget, including JSON escaping. */
  constructor(private readonly maxHistoryBytes: number) {}

  /**
   * Fold one existing Host follow publication, discarding all privileged payloads.
   * @param frame - authoritative Session stream publication.
   */
  accept(frame: SessionFollowFrame): void {
    if (frame.type === 'snapshot') {
      this.messages = []; this.richMessages = []; this.waiting.clear(); this.live = null; this.liveRich = null
      this.pendingApprovals.clear(); this.pendingQuestions.clear(); this.truncated = frame.hasMore
      for (const record of frame.records) this.event(record.event)
      const active = frame.assistantStream?.activeAttempt
      if (active) {
        this.live = { id: active.attemptId, role: 'assistant', text: '' }
        this.liveRich = { id: active.attemptId, role: 'assistant', blocks: [{ type: 'text', text: '' }] }
        for (const row of active.stream) {
          if (!isRecord(row)) continue
          if (row.type === 'text-chunks' && Array.isArray(row.texts)) {
            for (const text of row.texts) if (typeof text === 'string') this.delta(text)
          } else if (row.type === 'chunk' && isRecord(row.chunk) && row.chunk.type === 'text-delta' && typeof row.chunk.text === 'string') {
            this.delta(row.chunk.text)
          }
        }
      }
    } else if (frame.type === 'event') this.event(frame.event)
    else {
      const item = frame.frame
      if (item.type === 'start') {
        this.live = { id: item.attemptId, role: 'assistant', text: '' }
        this.liveRich = { id: item.attemptId, role: 'assistant', blocks: [{ type: 'text', text: '' }] }
      } else if (item.type === 'end') {
        this.live = null
        this.liveRich = null
      } else if (isRecord(item.chunk) && item.chunk.type === 'text-delta' && typeof item.chunk.text === 'string') {
        this.delta(item.chunk.text)
      }
    }
  }

  /**
   * Read only data allowed on the phone.
   * @param title - desktop-selected Session label.
   * @param running - current whole-Agent state, not per-message completion.
   * @param questions - whether the existing question projection has an answerable request.
   * @returns the current bounded excerpt and status.
   */
  snapshot(title: string, running: boolean, questions = false): MobileSnapshot {
    return { title, status: questions || this.waiting.size > 0 ? 'desktop-input-required' : running ? 'running' : 'idle',
      messages: this.messages, live: this.live, truncated: this.truncated }
  }

  /**
   * Rich structured snapshot carrying Markdown blocks and tool call status.
   * @param sessionId - Session identifier.
   * @param title - Session label.
   * @param running - current whole-Agent state.
   * @param questions - whether an interactive question is pending.
   * @param permissionMode - current permission mode.
   * @param model - current model selection.
   * @param availableModels - available model choices.
   * @returns the rich conversation snapshot.
   */
  richSnapshot(
    sessionId: SessionId,
    title: string,
    running: boolean,
    questions = false,
    permissionMode?: 'plan' | 'build' | 'auto' | 'yolo',
    model?: { readonly provider: string; readonly model: string; readonly displayName?: string },
    availableModels?: readonly MobileModelItem[],
  ): MobileRichSnapshot {
    return {
      sessionId,
      title,
      status: questions || this.waiting.size > 0 ? 'desktop-input-required' : running ? 'running' : 'idle',
      messages: this.richMessages,
      live: this.liveRich,
      truncated: this.truncated,
      ...(permissionMode ? { currentPermissionMode: permissionMode } : {}),
      ...(model ? { currentModel: model } : {}),
      ...(availableModels ? { availableModels } : {}),
    }
  }

  /** Read current pending approvals. */
  approvals(): readonly MobileApprovalItem[] {
    return [...this.pendingApprovals.values()]
  }

  /** Read current pending questions. */
  questions(): readonly MobileQuestionItem[] {
    return [...this.pendingQuestions.values()]
  }

  private delta(text: string): void {
    if (!this.live) return
    const combined = this.live.text + text
    let cropped = bounded(combined, 6000)
    while (Buffer.byteLength(JSON.stringify(cropped)) > 6500) cropped = bounded(cropped, Math.floor(Buffer.byteLength(cropped) * 0.8))
    this.truncated ||= cropped !== combined
    this.live = { ...this.live, text: cropped }
    if (this.liveRich) {
      this.liveRich = { ...this.liveRich, blocks: [{ type: 'text', text: cropped }] }
    }
  }

  private event(event: SessionWireEvent): void {
    if (isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') {
      // This bounded excerpt cannot reconstruct replaced, off-window surface nodes.
      this.messages = []; this.richMessages = []; this.live = null; this.liveRich = null; this.truncated = true
    }
    if (event.type === 'turn/end') {
      this.waiting.clear()
      this.pendingApprovals.clear()
      this.pendingQuestions.clear()
    }
    if (isRecord(event.data) && typeof event.data.id === 'string') {
      if (event.type === 'approval/asked') {
        this.waiting.add(event.data.id)
        const toolName = typeof event.data.tool === 'string' ? event.data.tool : 'command'
        const description = typeof event.data.displayReason === 'string' ? event.data.displayReason : (typeof event.data.reason === 'string' ? event.data.reason : 'Approval required')
        this.pendingApprovals.set(event.data.id, {
          id: event.data.id,
          toolName,
          description,
          riskLevel: toolName.includes('bash') || toolName.includes('kill') ? 'high' : 'normal',
        })
      }
      if (event.type === 'approval/decided') {
        this.waiting.delete(event.data.id)
        this.pendingApprovals.delete(event.data.id)
      }
    }
    if (event.type === 'tool/call' && isRecord(event.data)) {
      if (event.data.name === 'ask_user_question' && typeof event.data.callId === 'string') {
        this.waiting.add(event.data.callId)
        const args = isRecord(event.data.args) ? event.data.args : {}
        const rawQuestions = Array.isArray(args.questions) ? args.questions : []
        for (const q of rawQuestions) {
          if (isRecord(q) && typeof q.id === 'string' && typeof q.question === 'string') {
            const rawOptions = Array.isArray(q.options)
              ? q.options.flatMap(opt => isRecord(opt) && typeof opt.label === 'string'
                ? [typeof opt.description === 'string' ? { label: opt.label, description: opt.description } : { label: opt.label }]
                : [])
              : undefined
            this.pendingQuestions.set(q.id, {
              id: q.id,
              question: q.question,
              header: typeof q.header === 'string' ? q.header : undefined,
              multiSelect: q.multi_select === true,
              ...(rawOptions ? { options: rawOptions } : {}),
            })
          }
        }
      } else if (typeof event.data.callId === 'string' && typeof event.data.name === 'string') {
        const lastMsg = this.richMessages.at(-1)
        if (lastMsg && lastMsg.role === 'assistant') {
          const args = formatToolArgs(event.data.name, event.data.args)
          const updatedBlocks: MobileBlock[] = [
            ...lastMsg.blocks,
            {
              type: 'tool_call',
              callId: event.data.callId,
              name: event.data.name,
              args,
            },
          ]
          this.richMessages[this.richMessages.length - 1] = { ...lastMsg, blocks: updatedBlocks }
        }
      }
    }
    if (event.type === 'tool/result' && isRecord(event.data) && isRecord(event.data.message)) {
      if (typeof event.data.message.toolCallId === 'string') {
        this.waiting.delete(event.data.message.toolCallId)
        this.pendingQuestions.delete(event.data.message.toolCallId)
        const lastMsg = this.richMessages.at(-1)
        if (lastMsg && lastMsg.role === 'assistant') {
          const content = Array.isArray(event.data.message.content) ? event.data.message.content : []
          const textPart = content.find((p: unknown) => isRecord(p) && p.type === 'text' && typeof p.text === 'string') as { text: string } | undefined
          const summary = textPart ? bounded(textPart.text, 500) : undefined
          const updatedBlocks: MobileBlock[] = [
            ...lastMsg.blocks,
            {
              type: 'tool_result',
              callId: event.data.message.toolCallId,
              name: typeof event.data.name === 'string' ? event.data.name : 'tool',
              summary,
            },
          ]
          this.richMessages[this.richMessages.length - 1] = { ...lastMsg, blocks: updatedBlocks }
        }
      }
    }
    const role = event.type === 'user/message' ? 'user' : event.type === 'assistant/message' ? 'assistant' : undefined
    if (!role) return
    const data = role === 'assistant' && isRecord(event.data) ? event.data.message : event.data
    // Only directly authored user messages are shared, never injected context.
    if (role === 'user' && (!isRecord(data) || !isRecord(data.source) || data.source.kind !== 'user')) return
    const text = textContent(data)
    if (!text) return
    const cropped = bounded(text, 6000)
    this.truncated ||= cropped !== text
    this.messages.push({ id: String(event.seq), role, text: cropped })

    // Rich message accumulation
    const blocks = extractBlocks(data)
    if (blocks.length === 0) blocks.push({ type: 'text', text: cropped })
    this.richMessages.push({ id: String(event.seq), role, blocks })

    while (this.messages.length > 40 || Buffer.byteLength(JSON.stringify(this.messages)) > this.maxHistoryBytes
      || this.richMessages.length > 30 || Buffer.byteLength(JSON.stringify(this.richMessages)) > 18000) {
      this.messages.shift(); this.richMessages.shift(); this.truncated = true
    }
    if (role === 'assistant') {
      this.live = null
      this.liveRich = null
    }
  }
}
