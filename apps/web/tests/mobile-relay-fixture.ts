/** External relay double: the shipped Host owns encryption, authorization and Session execution. */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { MobileCipher, isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import type { MobileChannelId, MobileReply, MobileRequest } from '@deepseek-ai/dsh-api-mobile-controller/types'

interface Room {
  roomId: string
  deviceToken: string
  pairingTicket: string
  expiresAt: number
  authorizationExpiresAt: number
  socket?: WebSocket
}

/**
 * Bind one isolated external-service fixture without intercepting global fetch.
 * @returns room controls and a phone peer; none of their private material is logged.
 */
export async function mobileRelayFixture() {
  const desktopToken = randomBytes(32).toString('base64url')
  const rooms = new Map<string, Room>()
  const wss = new WebSocketServer({ noServer: true })
  let revocationAvailable = true
  let created = 0
  let nextRevocation: { reached: () => void; resumed: Promise<undefined> } | undefined
  const releases = new Set<() => void>()
  const server = createServer((request, response) => {
    if (request.url === '/desktop/rooms' && request.method === 'POST'
      && request.headers.authorization === `Bearer ${desktopToken}`) {
      created++
      const room: Room = { roomId: randomBytes(18).toString('base64url'), deviceToken: randomBytes(32).toString('base64url'),
        pairingTicket: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 120000, authorizationExpiresAt: Date.now() + 600000 }
      rooms.set(room.roomId, room)
      response.writeHead(201, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(room)); return
    }
    const match = /^\/device\/rooms\/([\w-]+)\/revoke$/.exec(request.url ?? '')
    if (match && request.method === 'POST') {
      const room = rooms.get(match[1]!)
      if (!revocationAvailable) { response.writeHead(503); response.end(); return }
      if (room && request.headers.authorization === `Bearer ${room.deviceToken}`) {
        const revoke = () => {
          rooms.delete(room.roomId); room.socket?.close(4001)
          response.writeHead(200); response.end('{}')
        }
        const held = nextRevocation
        nextRevocation = undefined
        if (held) { held.reached(); void held.resumed.then(revoke) }
        else revoke()
        return
      }
    }
    response.writeHead(401); response.end('{}')
  })
  server.on('upgrade', (request, socket, head) => {
    const id = request.headers['x-relay-room']
    const room = typeof id === 'string' ? rooms.get(id) : undefined
    if (!room || request.url !== '/ws/device' || request.headers.authorization !== `Bearer ${room.deviceToken}`) {
      socket.destroy(); return
    }
    wss.handleUpgrade(request, socket, head, (peer) => {
      room.socket?.close(4000)
      room.socket = peer
      peer.on('error', () => {})
      peer.send(JSON.stringify({ type: 'status', protocol: 1, mode: 'session-chat-e2ee', paired: false, mobileOnline: false }))
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('relay fixture did not bind')
  return {
    origin: `http://127.0.0.1:${address.port}`, desktopToken,
    get created() { return created },
    get activeRooms() { return rooms.size },
    revocation(available: boolean) { revocationAvailable = available },
    holdNextRevocation() {
      const entered = Promise.withResolvers<undefined>()
      const resumed = Promise.withResolvers<undefined>()
      const release = () => { releases.delete(release); resumed.resolve(undefined) }
      releases.add(release)
      nextRevocation = { reached: () => { entered.resolve(undefined) }, resumed: resumed.promise }
      return { entered: entered.promise, release }
    },
    pair(pairingUrl: string) {
      const fragment = new URLSearchParams(new URL(pairingUrl).hash.slice(1))
      const room = rooms.get(fragment.get('room') ?? '')
      if (!room?.socket || room.pairingTicket !== fragment.get('ticket')) throw new Error('fixture pairing unavailable')
      const transport = room.socket
      const codec = new MobileCipher(Buffer.from(fragment.get('key') ?? '', 'base64url'), room.roomId, 'mobile')
      const channel = randomBytes(16).toString('base64url') as MobileChannelId
      const replies: MobileReply[] = []
      const errors: unknown[] = []
      const read = (bytes: Buffer) => {
        try {
          const envelope: unknown = JSON.parse(bytes.toString())
          if (isRecord(envelope) && envelope.type === 'status') return
          const value = codec.open(envelope)
          if (isRecord(value) && value.channel === channel && (value.type === 'state' || value.type === 'receipt')) replies.push(value as MobileReply)
        } catch (error) { errors.push(error) }
      }
      transport.on('message', read)
      transport.send(JSON.stringify({ type: 'status', protocol: 1, mode: 'session-chat-e2ee', paired: true, mobileOnline: true }))
      const send = (request: Omit<MobileRequest, 'channel'> | Record<string, unknown>) => {
        transport.send(JSON.stringify(codec.seal({ ...request, channel })))
      }
      send({ type: 'hello' })
      return { replies, errors, send,
        get online() { return transport.readyState === WebSocket.OPEN },
        detach() { transport.off('message', read); codec.dispose() },
      }
    },
    async close() {
      for (const release of releases) release()
      const closed = Promise.all([...wss.clients].map(async (peer) => {
        const done = once(peer, 'close'); peer.terminate(); await done
      }))
      await closed
      await new Promise<void>((resolve, reject) => { wss.close((error) => { if (error) reject(error); else resolve() }) })
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve() }) })
      rooms.clear()
    },
  }
}
