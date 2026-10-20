/** External relay double: the shipped Host owns encryption, authorization and Session execution. */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket, WebSocketServer } from 'ws'
import { MobileCipher, isRecord } from '@deepseek-ai/dsh-api-mobile-controller/src/protocol.ts'
import { FullPackets } from '@deepseek-ai/dsh-api-mobile-controller/src/full-packets.ts'
import type { MobileChannelId, MobileReply, MobileRequest } from '@deepseek-ai/dsh-api-mobile-controller/types'

interface Room {
  full?: boolean
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
    if (['/desktop/rooms', '/desktop/devices'].includes(request.url ?? '') && request.method === 'POST'
      && request.headers.authorization === `Bearer ${desktopToken}`) {
      created++
      const room: Room = { full: request.url === '/desktop/devices', roomId: randomBytes(18).toString('base64url'), deviceToken: randomBytes(32).toString('base64url'),
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
      peer.send(JSON.stringify({ type: 'status', protocol: room.full ? 2 : 1, mode: room.full ? 'full-client-e2ee' : 'session-chat-e2ee', paired: false, mobileOnline: false }))
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
    pairFull(pairingUrl: string, { holdAcknowledgements = false } = {}) {
      const fragment = new URLSearchParams(new URL(pairingUrl).hash.slice(1))
      const room = rooms.get(fragment.get('room') ?? '')
      if (!room?.socket || !room.full) throw new Error('full-client fixture unavailable')
      const transport = room.socket
      const secret = Buffer.from(fragment.get('key') ?? '', 'base64url')
      const root = new MobileCipher(secret, room.roomId, 'mobile')
      const ready = Promise.withResolvers<undefined>()
      const replies: unknown[] = []
      const errors: unknown[] = []
      let heldAcknowledgements = 0
      let traffic: MobileCipher | undefined
      let packets: FullPackets | undefined
      let chain = Promise.resolve()
      const read = (bytes: Buffer) => {
        chain = chain.then(async () => {
          const envelope: unknown = JSON.parse(bytes.toString())
          if (isRecord(envelope) && envelope.type === 'status') return
          if (!traffic) {
            const challenge = root.open(envelope)
            if (!isRecord(challenge) || typeof challenge.nonce !== 'string') throw new Error('fixture challenge missing')
            const clientNonce = randomBytes(16).toString('base64url')
            traffic = new MobileCipher(secret, `${room.roomId}:${challenge.nonce}:${clientNonce}`, 'mobile')
            transport.send(JSON.stringify(root.seal({ type: 'authenticate', nonce: challenge.nonce, clientNonce })))
            return
          }
          const value = traffic.open(envelope)
          if (isRecord(value) && value.type === 'ready') {
            packets = new FullPackets(async (value) => {
              if (holdAcknowledgements && isRecord(value) && value.type === 'ack') { heldAcknowledgements++; return }
              transport.send(JSON.stringify(traffic!.seal(value)))
            }, (value) => {
              replies.push(value)
              if (isRecord(value) && (value.type === 'response' || value.type === 'body')) {
                void packets!.send({ type: 'response-pull', id: value.id }).catch((error: unknown) => { errors.push(error) })
              }
            }, 8)
            ready.resolve(undefined)
          } else if (value !== undefined) await packets?.accept(value)
        }).catch((error: unknown) => { errors.push(error); ready.reject(error) })
      }
      const closed = () => { ready.reject(new Error('Fixture transport closed before authentication')) }
      const detach = () => {
        transport.off('message', read); transport.off('close', closed)
        packets?.close(); traffic?.dispose(); root.dispose(); secret.fill(0)
      }
      transport.on('message', read)
      transport.on('close', closed)
      transport.send(JSON.stringify({ type: 'status', protocol: 2, mode: 'full-client-e2ee', paired: true, mobileOnline: true }))
      return { ready: ready.promise, replies, errors,
        get online() { return transport.readyState === WebSocket.OPEN },
        get heldAcknowledgements() { return heldAcknowledgements },
        async send(frame: object) { await ready.promise; await packets!.send(frame) },
        detach,
        disconnect() {
          detach()
          transport.send(JSON.stringify({ type: 'status', protocol: 2, mode: 'full-client-e2ee', paired: true, mobileOnline: false }))
        },
      }
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
