/** Bounded machine-only relay control; redirects and credential-bearing diagnostics are forbidden. */
import { WebSocket } from 'ws'
import { isRecord, MOBILE_WIRE } from './protocol.ts'

/** Room credentials remain on the Host for one authorization only. */
export interface RelayRoom {
  readonly roomId: string
  readonly deviceToken: string
  readonly pairingTicket: string
  readonly expiresAt: number
  readonly authorizationExpiresAt: number
}

/**
 * Read a small control response without retaining arbitrary server output.
 * @param response - relay HTTP response.
 * @returns parsed JSON.
 */
export async function controlJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw new Error('mobile relay request failed')
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > 4096) throw new Error('mobile relay response limit')
      parts.push(next.value)
    }
    const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
    return parsed
  } finally { await reader.cancel(); reader.releaseLock() }
}

/**
 * Create a room with the provisioned desktop credential, never the relay administrator key.
 * @param origin - configured HTTPS origin (loopback HTTP is allowed for tests).
 * @param credential - credential-store value resolved for this operation.
 * @param signal - caller lifetime combined with the request deadline.
 * @param full - request persistent instance access instead of a legacy text room.
 * @returns ephemeral room material after strict response validation.
 */
export async function createRoom(origin: string, credential: string, signal: AbortSignal, full = false): Promise<RelayRoom> {
  const value = await controlJson(await fetch(`${origin}/desktop/${full ? 'devices' : 'rooms'}`, {
    method: 'POST', headers: { authorization: `Bearer ${credential}` }, redirect: 'error', signal,
  }))
  if (!isRecord(value) || typeof value.roomId !== 'string' || !/^[A-Za-z0-9_-]{24}$/.test(value.roomId)
    || typeof value.deviceToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.deviceToken)
    || typeof value.pairingTicket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.pairingTicket)
    || typeof value.expiresAt !== 'number' || !Number.isSafeInteger(value.expiresAt)
    || typeof value.authorizationExpiresAt !== 'number' || !Number.isSafeInteger(value.authorizationExpiresAt)) throw new Error('invalid mobile room')
  return { roomId: value.roomId, deviceToken: value.deviceToken, pairingTicket: value.pairingTicket,
    expiresAt: value.expiresAt, authorizationExpiresAt: value.authorizationExpiresAt }
}

/**
 * Revoke this room only. Local denial must precede this network operation.
 * @param origin - configured relay origin.
 * @param room - per-room credential, not the desktop provisioning credential.
 * @param timeoutMs - bounded request deadline.
 * @returns true after acknowledged removal or an already absent room; false for an unknown remote outcome.
 */
export async function revokeRoom(origin: string, room: RelayRoom, timeoutMs: number): Promise<boolean> {
  try {
    const response = await fetch(`${origin}/device/rooms/${room.roomId}/revoke`, {
      method: 'POST', headers: { authorization: `Bearer ${room.deviceToken}` }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    })
    await response.body?.cancel()
    return response.status === 200 || response.status === 401
  } catch (_error) { return false }
}

/**
 * Open the outbound device WebSocket without putting credentials in its URL.
 * @param origin - configured relay origin.
 * @param room - per-room authentication.
 * @param timeoutMs - handshake deadline.
 * @returns a connecting socket owned by the authorization.
 */
export function connectDevice(origin: string, room: RelayRoom, timeoutMs: number): WebSocket {
  const url = new URL('/ws/device', origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return new WebSocket(url, 'dsh-relay.v1', { headers: { authorization: `Bearer ${room.deviceToken}`, 'X-Relay-Room': room.roomId },
    handshakeTimeout: timeoutMs, maxPayload: MOBILE_WIRE.maxWireBytes, perMessageDeflate: false, followRedirects: false })
}

/**
 * Reach transport quiescence, including a peer that ignores the close handshake.
 * @param socket - owned socket, if connection creation completed.
 * @returns after the socket emits close.
 */
export async function closeDevice(socket: WebSocket | undefined): Promise<void> {
  if (!socket || socket.readyState === WebSocket.CLOSED) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { socket.terminate() }, 500)
    socket.once('close', () => { clearTimeout(timer); resolve() })
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate()
    else socket.close(1000)
  })
}
