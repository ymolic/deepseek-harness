/** Bounded phone excerpts from the existing Session follow stream. */
import type { SessionFollowFrame, SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { isRecord } from './protocol.ts'
import type { MobileSnapshot, MobileText } from './types.ts'

function textContent(value: unknown): string {
  if (!isRecord(value) || !Array.isArray(value.content)) return ''
  return value.content.flatMap((part: unknown) => isRecord(part) && part.type === 'text' && typeof part.text === 'string'
    ? [part.text] : []).join('')
}

function bounded(text: string, bytes: number): string {
  const encoded = Buffer.from(text)
  if (encoded.length <= bytes) return text
  return new TextDecoder().decode(encoded.subarray(0, bytes - 3)).replace(/\uFFFD$/, '') + '…'
}

/** Keeps only recent user/assistant text; every frame is a full replacement. */
export class MobileProjection {
  private messages: MobileText[] = []
  private live: MobileText | null = null
  private truncated = false
  private readonly waiting = new Set<string>()

  /** @param maxHistoryBytes - total serialized text budget, including JSON escaping. */
  constructor(private readonly maxHistoryBytes: number) {}

  /**
   * Fold one existing Host follow publication, discarding all privileged payloads.
   * @param frame - authoritative Session stream publication.
   */
  accept(frame: SessionFollowFrame): void {
    if (frame.type === 'snapshot') {
      this.messages = []; this.waiting.clear(); this.live = null; this.truncated = frame.hasMore
      for (const record of frame.records) this.event(record.event)
      const active = frame.assistantStream?.activeAttempt
      if (active) {
        this.live = { id: active.attemptId, role: 'assistant', text: '' }
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
      if (item.type === 'start') this.live = { id: item.attemptId, role: 'assistant', text: '' }
      else if (item.type === 'end') this.live = null
      else if (isRecord(item.chunk) && item.chunk.type === 'text-delta' && typeof item.chunk.text === 'string') this.delta(item.chunk.text)
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

  private delta(text: string): void {
    if (!this.live) return
    const combined = this.live.text + text
    let cropped = bounded(combined, 6000)
    while (Buffer.byteLength(JSON.stringify(cropped)) > 6500) cropped = bounded(cropped, Math.floor(Buffer.byteLength(cropped) * 0.8))
    this.truncated ||= cropped !== combined
    this.live = { ...this.live, text: cropped }
  }

  private event(event: SessionWireEvent): void {
    if (isRecord(event.surfaceOp) && event.surfaceOp.op === 'replace') {
      // This bounded excerpt cannot reconstruct replaced, off-window surface nodes.
      this.messages = []; this.live = null; this.truncated = true
    }
    if (event.type === 'turn/end') this.waiting.clear()
    if (isRecord(event.data) && typeof event.data.id === 'string') {
      if (event.type === 'approval/asked') this.waiting.add(event.data.id)
      if (event.type === 'approval/decided') this.waiting.delete(event.data.id)
    }
    if (event.type === 'tool/call' && isRecord(event.data) && event.data.name === 'ask_user_question'
      && typeof event.data.callId === 'string') this.waiting.add(event.data.callId)
    if (event.type === 'tool/result' && isRecord(event.data) && isRecord(event.data.message)
      && typeof event.data.message.toolCallId === 'string') this.waiting.delete(event.data.message.toolCallId)
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
    while (this.messages.length > 40 || Buffer.byteLength(JSON.stringify(this.messages)) > this.maxHistoryBytes) {
      this.messages.shift(); this.truncated = true
    }
    if (role === 'assistant') this.live = null
  }
}
