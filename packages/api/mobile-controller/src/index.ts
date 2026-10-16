/** Persistent instance-wide phone access with a legacy text-client compatibility path. */
import { randomBytes, createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-title/types'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ApprovalRequest, ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { WebSocket } from 'ws'
import { MobileCipher, mobileRequest, isRecord, MOBILE_WIRE } from './protocol.ts'
import { MobileProjection } from './projection.ts'
import { FullMobileHost } from './full-host.ts'
import { createRoom, revokeRoom, connectDevice, closeDevice, type RelayRoom } from './relay-client.ts'
import type {
  MobileChannelId, MobileDesktopState, MobileReply, MobileRequestId, MobileReceiptStatus,
  MobileStartRequest, MobileStartResult, MobileWorkspaceSummary, MobileSessionSummary,
  MobileModelItem, MobileSessionStartRequest,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    mobileController: MobileController
  }
}

/** Relay deployment settings; authorizationMs and projection limits apply only to legacy text grants. */
export interface Config {
  /** Allow explicit desktop authorization; disabled instances create no relay connections. */
  readonly enabled: boolean
  /** Trusted relay's exact HTTPS origin; loopback HTTP is accepted for local tests. */
  readonly relayOrigin: string
  /** Credential-store key for the separately provisioned desktop identity. */
  readonly credential: string
  /** Grant duration in milliseconds, capped by the relay's remaining authorization. */
  readonly authorizationMs: number
  /** Deadline in milliseconds for control requests and WebSocket handshakes. */
  readonly requestTimeoutMs: number
  /** Maximum unacknowledged full-client download fragments; 1-32, independent of phone uploads. */
  readonly fullFragmentWindow: number
  /** Periodic interval in milliseconds for coalescing changed text into replacement snapshots. */
  readonly flushMs: number
  /** Maximum UTF-8 bytes of recent conversation text retained for the phone. */
  readonly historyBytes: number
}

interface Grant {
  agent: Agent
  readonly room: RelayRoom
  readonly cipher: MobileCipher
  readonly projection: MobileProjection
  readonly abort: AbortController
  readonly expiresAt: number
  readonly deadline: number
  readonly receipts: Map<MobileRequestId, { digest: string; status: MobileReceiptStatus }>
  readonly pendingApprovalAnswers: Map<string, (approved: boolean) => void>
  readonly pairingUrl: string
  task: Promise<void>
  observeAbort: AbortController | undefined
  socket: WebSocket | undefined
  channel: MobileChannelId | undefined
  revision: number
  dirty: boolean
  attempts: number
  retry: ReturnType<typeof setTimeout> | undefined
  stable: ReturnType<typeof setTimeout> | undefined
  tick: ReturnType<typeof setInterval> | undefined
}

/** Authenticated operator controls for enrollment and manual device revocation. */
export class MobileController extends TypertRemoteService {
  static inject = ['agents', 'sessionController', 'sessionProjections', 'credentials', 'workspaceRegistry',
    'connection', 'typertGateway', 'clientModules', 'frontendAssets']
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(false), relayOrigin: z.string().default(''),
    credential: z.string().default('DSH_MOBILE_DESKTOP_TOKEN'),
    authorizationMs: z.natural().min(1000).max(600000).default(600000),
    requestTimeoutMs: z.natural().min(100).max(15000).default(8000),
    fullFragmentWindow: z.natural().min(1).max(32).default(32),
    flushMs: z.natural().min(100).max(1000).default(250),
    historyBytes: z.natural().min(1000).max(16000).default(16000),
  })

  private readonly config: Config
  private grant: Grant | undefined
  private starting: AbortController | undefined
  private startTask: Promise<MobileStartResult> | undefined
  private stopping: Promise<boolean> | undefined
  private pendingRevoke: RelayRoom | undefined
  private disposed = false
  private state: MobileDesktopState
  private readonly full: FullMobileHost

  /**
   * @param ctx - Host services that already own Agents, permissions, and persistence.
   * @param config - resolved deployment configuration; enabling requires an exact trusted origin.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'mobileController', { namespace: 'mobile' })
    this.config = MobileController.Config(config)
    credentialRef(this.config.credential)
    if (this.config.enabled) {
      const url = new URL(this.config.relayOrigin)
      if (url.origin !== this.config.relayOrigin || url.username || url.password
        || !(url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))) {
        throw new Error('mobile relay requires an exact HTTPS origin')
      }
    }
    this.state = { phase: this.config.enabled ? 'stopped' : 'disabled', sessionId: null, title: '',
      expiresAt: null, ticketExpiresAt: null, relayRevoked: true }
    this.full = new FullMobileHost(ctx, this.config)
    ctx.on('agent/status', ({ agent }) => { if (this.grant?.agent === agent) this.grant.dirty = true }, { global: true })
    ctx.on('agent/disposed', ({ agent }) => { if (this.grant?.agent === agent) this.grant.dirty = true }, { global: true })

    // Intercept approval requests for mobile human-in-the-loop decision arbitration.
    ctx.on('approval/request', async (req: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      const activeGrant = this.grant
      if (!activeGrant || !this.valid(activeGrant) || req.agent !== activeGrant.agent) return next()
      activeGrant.dirty = true
      const id = req.callId ? String(req.callId) : req.toolName
      return new Promise<ApprovalOutcome>((resolve) => {
        const timer = setTimeout(() => {
          activeGrant.pendingApprovalAnswers.delete(id)
          resolve(next())
        }, 60000)
        activeGrant.pendingApprovalAnswers.set(id, (approved) => {
          clearTimeout(timer)
          resolve(approved ? 'allowed-once' : 'rejected')
        })
      })
    })

    ctx.effect(() => async () => {
      this.disposed = true
      this.starting?.abort()
      await this.end('stopped')
    }, 'mobile: authorization, stream and transport lifetime')
  }

  /**
   * Read enrollment and connection state for the authenticated operator.
   * @returns state with transient QR material only while enrollment is pending; never log it.
   */
  @Remote
  status(): MobileDesktopState {
    if (this.full.active()) return this.full.status()
    if (this.grant && this.valid(this.grant)) {
      return { ...this.state, pairingUrl: this.grant.pairingUrl }
    }
    return this.state
  }

  /**
   * Authorize the full instance, or a legacy Session grant when no full-device trust exists.
   * @param request - explicit instance consent or legacy Session selection and tool acknowledgement.
   * @returns a short-lived QR URL; keep it only in the desktop's transient view state.
   * @throws when disabled, already starting, revoked state is uncertain, or the selected Session cannot be used.
   */
  @Remote
  start(request: MobileStartRequest): Promise<MobileStartResult> {
    if ('scope' in request) {
      this.starting?.abort()
      return this.full.start(this.end('stopped'))
    }
    if (!this.config.enabled || this.disposed || this.starting) {
      throw new RemoteError('gateway/bad-request', 'Mobile authorization is unavailable.', {})
    }
    const abort = new AbortController()
    this.starting = abort
    const task = this.begin(request, abort)
    this.startTask = task
    void task.finally(() => {
      if (this.starting === abort) this.starting = undefined
      if (this.startTask === task) this.startTask = undefined
    }).catch((_error: unknown) => undefined)
    return task
  }

  /**
   * Stop local admission synchronously, then revoke the relay room.
   * @returns state distinguishing confirmed server revocation from an unknown network outcome.
   */
  @Remote
  async stop(): Promise<MobileDesktopState> {
    if (this.full.active()) return this.full.stop()
    await this.full.initialized()
    if (this.full.active()) return this.full.stop()
    this.starting?.abort()
    const starting = this.startTask
    await this.end('stopped')
    await starting?.catch((_error: unknown) => undefined)
    return this.state
  }

  private async begin(request: MobileSessionStartRequest, abort: AbortController): Promise<MobileStartResult> {
    let room: RelayRoom | undefined
    let installed = false
    try {
      await this.full.initialized()
      if (this.full.active()) throw new Error('instance device consent owns phone access')
      if (!await this.end('stopped')) throw new Error('relay revocation unconfirmed')
      abort.signal.throwIfAborted()
      this.state = { ...this.state, phase: 'starting' }
      const { items } = await this.ctx.sessionController.list({}, abort.signal)
      const selected = items.find(row => row.sessionId === request.sessionId)
      if (!selected || this.ctx.workspaceRegistry.archivedSessionIds.includes(request.sessionId)) throw new Error('session unavailable')
      const found = await this.ctx.sessionController.resolveAgent(request.sessionId)
      if ('error' in found) throw new Error('session unavailable')
      const credential = await this.ctx.credentials.resolve(credentialRef(this.config.credential))
      if (!credential || !/^[A-Za-z0-9_-]{32,256}$/.test(credential.value)) throw new Error('desktop credential unavailable')
      abort.signal.throwIfAborted()
      room = await createRoom(this.config.relayOrigin, credential.value,
        AbortSignal.any([abort.signal, AbortSignal.timeout(this.config.requestTimeoutMs)]))
      abort.signal.throwIfAborted()
      const duration = Math.min(this.config.authorizationMs, room.authorizationExpiresAt - Date.now())
      if (duration <= 0 || room.expiresAt <= Date.now()) throw new Error('authorization expired')
      const secret = randomBytes(32)
      const cipher = new MobileCipher(secret, room.roomId)
      const expiresAt = Date.now() + duration
      const observeAbort = new AbortController()
      const fragment = new URLSearchParams({ room: room.roomId, ticket: room.pairingTicket, key: secret.toString('base64url') })
      secret.fill(0)
      const pairingUrl = `${this.config.relayOrigin}/#${fragment}`
      const grant: Grant = {
        agent: found.agent, room, cipher, projection: new MobileProjection(this.config.historyBytes),
        abort: new AbortController(), expiresAt, deadline: performance.now() + duration, receipts: new Map(),
        pendingApprovalAnswers: new Map(), task: Promise.resolve(), observeAbort, pairingUrl,
        socket: undefined, channel: undefined, revision: 0, dirty: true, attempts: 0, retry: undefined, stable: undefined, tick: undefined,
      }
      this.grant = grant
      installed = true
      this.state = { phase: 'waiting', sessionId: request.sessionId, title: (selected.projections?.values.title ?? '').slice(0, 160),
        expiresAt, ticketExpiresAt: room.expiresAt, relayRevoked: false, pairingUrl }
      grant.task = this.observe(grant, observeAbort.signal)
      grant.tick = setInterval(() => {
        if (!this.valid(grant)) { void this.end('expired'); return }
        if (grant.dirty) this.flush(grant)
      }, this.config.flushMs)
      await this.connect(grant)
      abort.signal.throwIfAborted()
      if (!this.valid(grant)) throw new Error('authorization ended')
      return { pairingUrl, state: this.state }
    } catch (_error) {
      const phase = abort.signal.aborted || this.disposed ? 'stopped' : 'failed'
      // A room can arrive after Stop aborted its caller but before a Grant exists.
      if (room && !installed) this.pendingRevoke = room
      await this.end(phase)
      throw new RemoteError('gateway/internal', 'Mobile authorization failed. Check the relay configuration and try again.', {})
    }
  }

  private valid(grant: Grant): boolean {
    return !this.disposed && this.grant === grant && !grant.abort.signal.aborted
      && performance.now() < grant.deadline && Date.now() < grant.expiresAt
  }

  private async getWorkspaceSummaries(): Promise<MobileWorkspaceSummary[]> {
    try {
      const workspaces = this.ctx.workspaceRegistry.list()
      let sessions: readonly SessionSummary[] = []
      try {
        const result = await this.ctx.sessionController.list({}, new AbortController().signal)
        sessions = result.items
      } catch (err) {
        this.ctx.logger.warn('mobile getWorkspaceSummaries: sessionController.list failed: %o', err)
      }
      const sessionMap = new Map(sessions.map(s => [s.sessionId, s]))
      const archived = new Set(this.ctx.workspaceRegistry.archivedSessionIds)
      const pinned = new Set(this.ctx.workspaceRegistry.pinnedSessionIds)
      const summaries: MobileWorkspaceSummary[] = []
      const accounted = new Set<string>()

      for (const ws of workspaces) {
        const wsSessions: MobileSessionSummary[] = []
        for (const sId of ws.sessionIds) {
          if (archived.has(sId)) continue
          accounted.add(sId)
          const info = sessionMap.get(sId)
          const activeAgent = this.ctx.agents.get(sId)
          const status = activeAgent ? (activeAgent.status === 'running' ? 'running' : 'idle') : 'idle'
          let title = (info?.projections?.values.title ?? '').slice(0, 100)
          if (!title && activeAgent) {
            title = (this.ctx.sessionProjections.snapshot(activeAgent.session, ['title']).values.title ?? '').slice(0, 100)
          }
          if (!title) title = '新会话'
          const updatedAt = typeof info?.updatedAt === 'number' ? info.updatedAt : Date.now()
          wsSessions.push({ sessionId: sId, title, updatedAt, status, pinned: pinned.has(sId) })
          if (wsSessions.length >= 25) break
        }
        wsSessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
        summaries.push({
          workspaceId: ws.id,
          name: ws.title || ws.path,
          sessions: wsSessions,
        })
      }

      const unassigned: MobileSessionSummary[] = []
      for (const s of sessions) {
        if (!accounted.has(s.sessionId) && !archived.has(s.sessionId)) {
          const activeAgent = this.ctx.agents.get(s.sessionId)
          const status = activeAgent ? (activeAgent.status === 'running' ? 'running' : 'idle') : 'idle'
          let title = (s.projections?.values.title ?? '').slice(0, 100)
          if (!title && activeAgent) {
            title = (this.ctx.sessionProjections.snapshot(activeAgent.session, ['title']).values.title ?? '').slice(0, 100)
          }
          if (!title) title = '新会话'
          unassigned.push({ sessionId: s.sessionId, title, updatedAt: s.updatedAt || Date.now(), status, pinned: pinned.has(s.sessionId) })
          if (unassigned.length >= 25) break
        }
        unassigned.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt)
      }
      if (unassigned.length > 0) {
        summaries.push({
          workspaceId: 'default',
          name: '默认工作区',
          sessions: unassigned,
        })
      }
      while (Buffer.byteLength(JSON.stringify(summaries)) > 20000) {
        let oldestWs: MobileWorkspaceSummary | undefined
        let oldestIndex = -1
        let oldestTime = Infinity
        for (const ws of summaries) {
          for (let i = 0; i < ws.sessions.length; i++) {
            const sess = ws.sessions[i]
            if (!sess) continue
            if (!sess.pinned && sess.updatedAt < oldestTime) {
              oldestTime = sess.updatedAt
              oldestWs = ws
              oldestIndex = i
            }
          }
        }
        if (oldestWs && oldestIndex >= 0) {
          (oldestWs.sessions as MobileSessionSummary[]).splice(oldestIndex, 1)
        } else {
          break
        }
      }
      return summaries
    } catch {
      return []
    }
  }

  private async switchSession(grant: Grant, targetSessionId: SessionId): Promise<boolean> {
    if (!this.valid(grant)) return false
    if (this.ctx.workspaceRegistry.archivedSessionIds.includes(targetSessionId)) return false
    const found = await this.ctx.sessionController.resolveAgent(targetSessionId)
    if ('error' in found) return false
    grant.observeAbort?.abort()
    grant.agent = found.agent
    const newAbort = new AbortController()
    grant.observeAbort = newAbort
    const titleVal = this.ctx.sessionProjections.snapshot(found.agent.session, ['title']).values.title
    this.state = {
      ...this.state,
      sessionId: targetSessionId,
      title: typeof titleVal === 'string' ? titleVal.slice(0, 160) : 'Session',
    }
    grant.task = this.observe(grant, newAbort.signal)
    grant.dirty = true
    this.flush(grant)
    return true
  }

  private async observe(grant: Grant, signal: AbortSignal): Promise<void> {
    try {
      for await (const frame of this.ctx.sessionController.follow({ address: { kind: 'session', sessionId: grant.agent.id },
        maxMessages: 40, assistantStream: true }, signal)) {
        if (!this.valid(grant) || signal.aborted) return
        grant.projection.accept(frame)
        grant.dirty = true
      }
    } catch (_error) {
      this.ctx.logger.warn('mobile session follow ended: %o', _error)
    }
  }

  private connect(grant: Grant): Promise<void> {
    const socket = connectDevice(this.config.relayOrigin, grant.room, this.config.requestTimeoutMs)
    grant.socket = socket
    grant.channel = undefined
    return new Promise<void>((resolve, reject) => {
      socket.once('open', () => {
        if (!this.valid(grant)) { socket.close(); reject(new Error('authorization ended')); return }
        grant.stable = setTimeout(() => { grant.attempts = 0 }, 30000)
        this.state = { ...this.state, phase: 'waiting' }
        resolve()
      })
      socket.on('message', (bytes, binary) => {
        void (async () => {
          if (!this.valid(grant) || grant.socket !== socket) return
          try {
            const data = Array.isArray(bytes) ? Buffer.concat(bytes) : Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
            if (binary || data.length > MOBILE_WIRE.maxWireBytes) throw new Error('invalid mobile frame')
            const value: unknown = JSON.parse(data.toString('utf8'))
            if (isRecord(value) && value.type === 'status') {
              if (value.protocol !== 1 || value.mode !== 'session-chat-e2ee') throw new Error('unsupported mobile relay')
              if (value.mobileOnline !== true) grant.channel = undefined
              this.state = { ...this.state, phase: value.paired === true ? 'paired' : 'waiting' }
              return
            }
            const plain = grant.cipher.open(value)
            if (plain === undefined) return
            const request = mobileRequest(plain)
            if (!request) return
            if (request.type === 'hello') { grant.cipher.rotateSend(); grant.channel = request.channel; grant.dirty = true; this.flush(grant); return }
            if (request.channel !== grant.channel) return
            if (request.type === 'sync') { grant.dirty = true; this.flush(grant); return }

            if (request.type === 'workspace:list') {
              try {
                const summaries = await this.getWorkspaceSummaries()
                this.reply(grant, {
                  type: 'workspace:state',
                  channel: request.channel,
                  revision: ++grant.revision,
                  workspaces: summaries,
                  activeSessionId: grant.agent.id,
                })
              } catch (err) {
                this.ctx.logger.warn('mobile workspace:list error: %o', err)
              }
              return
            }
            if (request.type === 'workspace:switch' || request.type === 'session:follow') {
              const targetId = request.sessionId
              if (targetId) {
                await this.switchSession(grant, targetId)
              }
              return
            }
            if (request.type === 'session:create') {
              try {
                const created = await this.ctx.sessionController.create({
                  ...(request.workspaceId && request.workspaceId !== 'default' ? { workspaceId: WorkspaceId(request.workspaceId) } : {}),
                })
                if (created.sessionId) {
                  await this.switchSession(grant, created.sessionId)
                  const summaries = await this.getWorkspaceSummaries()
                  this.reply(grant, {
                    type: 'workspace:state',
                    channel: request.channel,
                    revision: ++grant.revision,
                    workspaces: summaries,
                    activeSessionId: grant.agent.id,
                  })
                }
              } catch (err) {
                this.ctx.logger.warn('mobile session:create error: %o', err)
              }
              return
            }
            if (request.type === 'session:permission') {
              try {
                const planMode = this.ctx.get('planMode') as { set(agent: Agent, active: boolean): void } | undefined
                const permissionPresets = this.ctx.get('permissionPresets') as { set(session: unknown, name: string): void } | undefined
                if (request.mode === 'plan') {
                  planMode?.set(grant.agent, true)
                  permissionPresets?.set(grant.agent.session, 'workspace-write')
                } else {
                  planMode?.set(grant.agent, false)
                  if (request.mode === 'build') {
                    permissionPresets?.set(grant.agent.session, 'workspace-write')
                  } else if (request.mode === 'auto') {
                    permissionPresets?.set(grant.agent.session, 'auto')
                  } else {
                    permissionPresets?.set(grant.agent.session, 'danger-full-access')
                  }
                }
                this.reply(grant, {
                  type: 'permission:state',
                  channel: request.channel,
                  mode: request.mode,
                })
                grant.dirty = true
                this.flush(grant)
              } catch (err) {
                this.ctx.logger.warn('mobile session:permission error: %o', err)
              }
              return
            }
            if (request.type === 'model:list') {
              try {
                const catalog = await this.ctx.sessionController.modelCatalog()
                const models: MobileModelItem[] = []
                for (const group of catalog.groups) {
                  for (const m of group.models) {
                    models.push({
                      id: m.id,
                      name: m.name,
                      provider: group.id,
                      ...(m.description ? { description: m.description } : {}),
                    })
                  }
                }
                this.reply(grant, {
                  type: 'model:catalog',
                  channel: request.channel,
                  models,
                })
              } catch (err) {
                this.ctx.logger.warn('mobile model:list error: %o', err)
              }
              return
            }
            if (request.type === 'session:select_model') {
              try {
                await this.ctx.sessionController.selectModel({
                  sessionId: grant.agent.id,
                  provider: request.provider,
                  model: request.model,
                })
                grant.dirty = true
                this.flush(grant)
              } catch (err) {
                this.ctx.logger.warn('mobile session:select_model error: %o', err)
              }
              return
            }
            if (request.type === 'session:rename') {
              try {
                const sessionTitle = this.ctx.get('sessionTitle') as { rename(session: unknown, name: string): void } | undefined
                let targetAgent = this.ctx.agents.get(request.sessionId)
                if (!targetAgent) {
                  const resolved = await this.ctx.sessionController.resolveAgent(request.sessionId)
                  if ('agent' in resolved) targetAgent = resolved.agent
                }
                if (targetAgent && sessionTitle) {
                  sessionTitle.rename(targetAgent.session, request.title)
                }
                const summaries = await this.getWorkspaceSummaries()
                this.reply(grant, {
                  type: 'workspace:state',
                  channel: request.channel,
                  revision: ++grant.revision,
                  workspaces: summaries,
                  activeSessionId: grant.agent.id,
                })
                grant.dirty = true
                this.flush(grant)
              } catch (err) {
                this.ctx.logger.warn('mobile session:rename error: %o', err)
              }
              return
            }
            if (request.type === 'session:archive') {
              try {
                await this.ctx.workspaceRegistry.archiveSession(request.sessionId)
                if (grant.agent.id === request.sessionId) {
                  const summaries = await this.getWorkspaceSummaries()
                  const firstOther = summaries.flatMap(w => w.sessions).find(s => s.sessionId !== request.sessionId)
                  if (firstOther) {
                    await this.switchSession(grant, firstOther.sessionId)
                  }
                }
                const summaries = await this.getWorkspaceSummaries()
                this.reply(grant, {
                  type: 'workspace:state',
                  channel: request.channel,
                  revision: ++grant.revision,
                  workspaces: summaries,
                  activeSessionId: grant.agent.id,
                })
                grant.dirty = true
                this.flush(grant)
              } catch (err) {
                this.ctx.logger.warn('mobile session:archive error: %o', err)
              }
              return
            }
            if (request.type === 'session:pin') {
              try {
                await this.ctx.workspaceRegistry.pinSession(request.sessionId)
                const summaries = await this.getWorkspaceSummaries()
                this.reply(grant, {
                  type: 'workspace:state',
                  channel: request.channel,
                  revision: ++grant.revision,
                  workspaces: summaries,
                  activeSessionId: grant.agent.id,
                })
              } catch (err) {
                this.ctx.logger.warn('mobile session:pin error: %o', err)
              }
              return
            }
            if (request.type === 'session:unpin') {
              try {
                await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
                const summaries = await this.getWorkspaceSummaries()
                this.reply(grant, {
                  type: 'workspace:state',
                  channel: request.channel,
                  revision: ++grant.revision,
                  workspaces: summaries,
                  activeSessionId: grant.agent.id,
                })
              } catch (err) {
                this.ctx.logger.warn('mobile session:unpin error: %o', err)
              }
              return
            }
            if (request.type === 'session:cancel') {
              this.ctx.sessionController.cancel({ sessionId: request.sessionId })
              grant.dirty = true
              return
            }
            if (request.type === 'approval:respond') {
              const responder = grant.pendingApprovalAnswers.get(request.requestId)
              if (responder) {
                responder(request.approved)
                grant.pendingApprovalAnswers.delete(request.requestId)
              }
              grant.dirty = true
              return
            }
            if (request.type === 'question:answer') {
              const userQuestions = this.ctx.get('userQuestions')
              if (userQuestions && typeof userQuestions.answer === 'function') {
                const batch: AskUserQuestionAnswer = {
                  answers: Object.entries(request.answers).map(([id, val]) => ({ id, selected: [val] })),
                }
                userQuestions.answer(grant.agent, request.questionId as ToolCallId, batch)
              }
              grant.dirty = true
              return
            }
            if (request.type === 'receipt') {
              this.reply(grant, { type: 'receipt', channel: request.channel, id: request.id, status: grant.receipts.get(request.id)?.status ?? 'not-seen' })
              return
            }
            const digest = createHash('sha256').update(request.text).digest('hex')
            const previous = grant.receipts.get(request.id)
            let status: MobileReceiptStatus
            if (previous) status = previous.digest === digest ? previous.status : 'conflict'
            else if (grant.receipts.size >= 256) status = 'limit'
            else {
              const targetId = request.sessionId || grant.agent.id
              let targetAgent = this.ctx.agents.get(targetId)
              if (!targetAgent) {
                const resolved = await this.ctx.sessionController.resolveAgent(targetId)
                if ('agent' in resolved) targetAgent = resolved.agent
              }
              if (!targetAgent) targetAgent = grant.agent
              status = targetAgent.status === 'running' ? 'busy' : 'unknown'
              const receipt: { digest: string; status: MobileReceiptStatus } = { digest, status }
              grant.receipts.set(request.id, receipt)
              if (status === 'unknown') {
                // No await separates the last authority check and synchronous inbox admission.
                if (!this.valid(grant) || socket.readyState !== WebSocket.OPEN) throw new Error('authorization ended')
                try {
                  targetAgent.followup(createUserMessage({ content: [{ type: 'text', text: request.text }],
                    source: { kind: 'user', rpcId: request.id as string as SessionRequestId } }))
                  receipt.status = status = 'accepted'
                } catch (_error) { /* Admission may have committed: keep the unknown receipt and never repeat it. */ }
              }
            }
            this.reply(grant, { type: 'receipt', channel: request.channel, id: request.id, status })
            grant.dirty = true
          } catch (_error) {
            this.ctx.logger.warn('mobile socket message handling error: %o', _error)
          }
        })()
      })
      socket.on('error', (_error) => { reject(new Error('mobile transport unavailable')) })
      socket.once('close', (code) => {
        clearTimeout(grant.stable)
        grant.channel = undefined
        reject(new Error('mobile transport closed'))
        if (!this.valid(grant) || grant.socket !== socket) return
        if ([4000, 4001].includes(code) || grant.attempts >= 3) { void this.end(code === 4001 ? 'expired' : 'failed'); return }
        this.state = { ...this.state, phase: 'reconnecting' }
        grant.retry = setTimeout(() => {
          if (!this.valid(grant)) return
          grant.attempts++
          void this.connect(grant).catch((_error: unknown) => undefined)
        }, 1000 * 2 ** grant.attempts)
      })
    })
  }

  private reply(grant: Grant, reply: MobileReply): void {
    if (!this.valid(grant) || grant.socket?.readyState !== WebSocket.OPEN) return
    try {
      const text = JSON.stringify(grant.cipher.seal(reply))
      if (grant.socket.bufferedAmount + Buffer.byteLength(text) > 64 * 1024) { grant.socket.close(1013); return }
      grant.socket.send(text, (error) => { if (error && this.valid(grant)) grant.socket?.close(1011) })
    } catch (error) {
      this.ctx.logger.warn('mobile reply seal/send failed: %o', error)
    }
  }

  private flush(grant: Grant): void {
    if (!grant.channel || grant.socket?.readyState !== WebSocket.OPEN) return
    try {
      const questions = this.ctx.sessionProjections.snapshot(grant.agent.session, ['userQuestions']).values.userQuestions
      const needsAnswer = isRecord(questions) && Array.isArray(questions.active) && questions.active.length > 0

      let currentPermissionMode: 'plan' | 'build' | 'auto' | 'yolo' = 'build'
      try {
        const planMode = this.ctx.get('planMode') as { loggedActive(session: unknown): boolean } | undefined
        const permissionPresets = this.ctx.get('permissionPresets') as { current(session: unknown): string } | undefined
        if (planMode && planMode.loggedActive(grant.agent.session)) {
          currentPermissionMode = 'plan'
        } else if (permissionPresets) {
          const cur = permissionPresets.current(grant.agent.session)
          if (cur === 'danger-full-access') currentPermissionMode = 'yolo'
          else if (cur === 'auto') currentPermissionMode = 'auto'
          else currentPermissionMode = 'build'
        }
      } catch {}

      let currentModel: { readonly provider: string; readonly model: string; readonly displayName?: string } | undefined
      try {
        const modelSnapshot = this.ctx.sessionProjections.snapshot(grant.agent.session, ['modelSelection']).values.modelSelection
        if (isRecord(modelSnapshot)) {
          const lastUsed = isRecord(modelSnapshot.lastUsed) ? modelSnapshot.lastUsed : undefined
          const next = isRecord(modelSnapshot.next) ? modelSnapshot.next : undefined
          const sel = next ?? lastUsed
          if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') {
            currentModel = { provider: sel.provider, model: sel.model, displayName: sel.model }
          }
        }
      } catch {}
      if (!currentModel) {
        try {
          const def = (this.ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined)?.currentSelection()
          if (def && typeof def.provider === 'string' && typeof def.model === 'string') {
            currentModel = { provider: def.provider, model: def.model, displayName: def.model }
          }
        } catch {}
      }

      // Backward-compatible v1 plain state
      this.reply(grant, {
        type: 'state',
        channel: grant.channel,
        revision: ++grant.revision,
        expiresAt: grant.expiresAt,
        value: grant.projection.snapshot(this.state.title, grant.agent.status === 'running', needsAnswer),
      })
      // Rich structured state
      this.reply(grant, {
        type: 'rich_state',
        channel: grant.channel,
        revision: ++grant.revision,
        expiresAt: grant.expiresAt,
        value: grant.projection.richSnapshot(
          grant.agent.id,
          this.state.title,
          grant.agent.status === 'running',
          needsAnswer,
          currentPermissionMode,
          currentModel,
        ),
      })
      // Active human-in-the-loop approvals
      const approvals = grant.projection.approvals()
      if (approvals.length > 0) {
        this.reply(grant, { type: 'approval:active', channel: grant.channel, pending: approvals })
      }
      // Active human-in-the-loop questions
      const pendingQuestions = grant.projection.questions()
      if (pendingQuestions.length > 0) {
        this.reply(grant, { type: 'question:active', channel: grant.channel, pending: pendingQuestions })
      }
      grant.dirty = false
    } catch (_error) {
      this.ctx.logger.warn('mobile flush error: %o', _error)
    }
  }

  private end(phase: MobileDesktopState['phase']): Promise<boolean> {
    const grant = this.grant
    let closing = Promise.resolve()
    if (grant) {
      this.grant = undefined
      this.pendingRevoke = grant.room
      grant.abort.abort()
      grant.observeAbort?.abort()
      clearInterval(grant.tick); clearTimeout(grant.retry); clearTimeout(grant.stable)
      grant.cipher.dispose()
      grant.receipts.clear()
      closing = closeDevice(grant.socket)
    }
    this.state = { ...this.state, phase, relayRevoked: this.pendingRevoke === undefined }
    if (this.stopping) return this.stopping
    const room = this.pendingRevoke
    if (!room) return Promise.resolve(true)
    const task = (async () => {
      const [revoked] = await Promise.all([
        revokeRoom(this.config.relayOrigin, room, this.config.requestTimeoutMs), closing, grant?.task,
      ])
      if (revoked && this.pendingRevoke === room) this.pendingRevoke = undefined
      this.state = { ...this.state, relayRevoked: revoked }
      return revoked
    })()
    this.stopping = task
    void task.finally(() => { if (this.stopping === task) this.stopping = undefined }).catch((_error: unknown) => undefined)
    return task
  }
}

export default MobileController
