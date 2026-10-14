import { describe, expect, it } from 'vitest'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import { MobileProjection } from '../src/projection.ts'

const event = (type: string, data: SessionWireEvent['data'], seq = 1): SessionWireEvent => ({ type, data, seq, time: 0 })
const user = (text: string, kind = 'user') => ({ content: [{ type: 'text', text }], source: { kind } })

describe('phone Session excerpts', () => {
  it('shares directly authored user and assistant text while dropping privileged payloads', () => {
    const projection = new MobileProjection(16000)
    for (const row of [
      event('system/update', user('system secret')),
      event('user/message', user('runtime secret', 'runtime-context')),
      event('user/message', user('question reply', 'user-question-reply')),
      event('tool/result', { message: { content: [{ type: 'text', text: 'raw tool secret' }] } }),
      event('user/message', user('phone question'), 5),
      event('assistant/message', { message: { content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'visible answer' }] } }, 6),
    ]) projection.accept({ type: 'event', event: row })
    expect(projection.snapshot('Selected session', false)).toEqual({
      title: 'Selected session', status: 'idle', live: null, truncated: false,
      messages: [{ id: '5', role: 'user', text: 'phone question' }, { id: '6', role: 'assistant', text: 'visible answer' }],
    })
  })

  it('clears excerpts invalidated by replacements without publishing compaction input', () => {
    const projection = new MobileProjection(16000)
    projection.accept({ type: 'event', event: event('user/message', user('old text')) })
    projection.accept({ type: 'event', event: { ...event('user/message', user('compacted context', 'compaction'), 2),
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } } })
    expect(projection.snapshot('', false)).toMatchObject({ messages: [], truncated: true })
  })

  it('reports pending desktop decisions and bounds escaped multibyte text', () => {
    const projection = new MobileProjection(1000)
    projection.accept({ type: 'event', event: event('approval/asked', { id: 'approval' }) })
    expect(projection.snapshot('', true).status).toBe('desktop-input-required')
    projection.accept({ type: 'event', event: event('approval/decided', { id: 'approval' }) })
    projection.accept({ type: 'event', event: event('tool/call', { name: 'ask_user_question', callId: 'question' }) })
    expect(projection.snapshot('', true).status).toBe('desktop-input-required')
    projection.accept({ type: 'event', event: event('tool/result', { message: { toolCallId: 'question' } }) })
    expect(projection.snapshot('', true).status).toBe('running')
    expect(projection.snapshot('', false, true).status).toBe('desktop-input-required')
    for (let seq = 1; seq <= 60; seq++) projection.accept({ type: 'event', event: event('user/message', user('汉字\u0000'.repeat(100)), seq) })
    const result = projection.snapshot('', false)
    expect(Buffer.byteLength(JSON.stringify(result.messages))).toBeLessThanOrEqual(1000)
    expect(result.truncated).toBe(true)
  })
})
