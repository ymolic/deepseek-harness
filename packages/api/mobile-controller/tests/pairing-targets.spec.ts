/** Synthetic credentials and isolated relay rooms; never contact the running application's credential provider. */
import { Context } from '@deepseek-ai/cordis'
import { credentialKey, type CredentialKey, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { expect, it, vi } from 'vitest'
import { mobileRelayFixture } from '../../../../apps/web/tests/mobile-relay-fixture.ts'
import { FullMobileHost } from '../src/full-host.ts'
import { MobileController } from '../src/index.ts'
import { isRecord, MobileCipher } from '../src/protocol.ts'
import type { MobilePairingTarget, MobileStartRequest } from '../src/types.ts'

const browserKey = credentialKey('mobile-controller', 'trusted-device')
const appKey = credentialKey('mobile-controller', 'trusted-app-device')

function owner(origin: string, desktopToken: string, records = new Map<CredentialKey, CredentialRecord>()) {
  const ctx = new Context()
  ctx.provide('credentials', {
    resolve: async () => ({ value: desktopToken, source: 'synthetic' }),
    readRecord: async (key: CredentialKey) => records.get(key),
    modifyRecord: async (key: CredentialKey, mutate: (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) => {
      const value = await mutate(records.get(key))
      if (value) records.set(key, value)
      return records.get(key)
    },
    deleteRecord: async (key: CredentialKey) => { records.delete(key) },
  })
  ctx.provide('connection', { createPeer: () => ({ principal: { kind: 'owner' } }) })
  ctx.provide('frontendAssets', { fetch: async () => new Response('isolated application') })
  const config = MobileController.Config({ enabled: true, relayOrigin: origin } as never)
  return { ctx, config, records }
}

function fragments(url: string) { return new URLSearchParams(new URL(url).hash.slice(1)) }

it('keeps browser and App simultaneously authenticated in separate rooms and rotates or revokes only the selected slot', async () => {
  const relay = await mobileRelayFixture()
  const { ctx, config, records } = owner(relay.origin, relay.desktopToken)
  const browser = new FullMobileHost(ctx, config), app = new FullMobileHost(ctx, config, 'app')
  const phones: ReturnType<typeof relay.pairFull>[] = []
  try {
    const [browserQR, appQR] = await Promise.all([browser.start(), app.start()])
    expect(new URL(browserQR.pairingUrl).origin).toBe(relay.origin)
    expect(new URL(appQR.pairingUrl).protocol).toBe('dshapp:')
    expect(new URL(appQR.pairingUrl).host).toBe(new URL(relay.origin).host)
    expect([...fragments(appQR.pairingUrl).keys()]).toEqual(['room', 'ticket', 'key', 'mode'])
    expect(fragments(appQR.pairingUrl).get('mode')).toBe('full')
    for (const key of ['room', 'ticket', 'key']) {
      expect(fragments(browserQR.pairingUrl).get(key) === fragments(appQR.pairingUrl).get(key)).toBe(false)
    }
    expect(records.size).toBe(2)
    let browserRecord = records.get(browserKey)
    const browserPhone = relay.pairFull(browserQR.pairingUrl), appPhone = relay.pairFull(appQR.pairingUrl)
    phones.push(browserPhone, appPhone)
    await Promise.all(phones.map(phone => phone.ready))
    expect(browser.status().mobileOnline).toBe(true)
    expect(app.status().mobileOnline).toBe(true)
    expect(browser.status().pairingUrl).toBeUndefined()
    expect(app.status().pairingUrl).toBeUndefined()
    await Promise.all(phones.map((phone, index) => phone.send({ type: 'fetch', id: `separate-target-${index}`, url: '/', method: 'GET', headers: {} })))
    await expect.poll(() => phones.every(phone => phone.replies.some(frame => isRecord(frame) && frame.type === 'end'))).toBe(true)
    expect(browserPhone.replies.some(frame => isRecord(frame) && frame.id === 'separate-target-1')).toBe(false)
    expect(appPhone.replies.some(frame => isRecord(frame) && frame.id === 'separate-target-0')).toBe(false)

    const rotated = await app.start()
    expect(records.get(browserKey) === browserRecord).toBe(true)
    expect(browser.status().mobileOnline).toBe(true)
    expect(browserPhone.online).toBe(true)
    expect(appPhone.online).toBe(false)
    expect(relay.activeRooms).toBe(2)
    const replacement = relay.pairFull(rotated.pairingUrl)
    phones.push(replacement)
    await replacement.ready
    const appRecord = records.get(appKey)
    const rotatedBrowser = await browser.start()
    expect(records.get(appKey) === appRecord).toBe(true)
    expect(app.status().mobileOnline).toBe(true)
    expect(replacement.online).toBe(true)
    expect(browserPhone.online).toBe(false)
    const browserReplacement = relay.pairFull(rotatedBrowser.pairingUrl)
    phones.push(browserReplacement)
    await browserReplacement.ready
    browserRecord = records.get(browserKey)
    relay.revocation(false)
    await expect(app.stop()).rejects.toThrow('relay revocation unconfirmed')
    expect(app.status().relayRevoked).toBe(false)
    expect(browser.status().mobileOnline).toBe(true)
    expect(records.get(browserKey) === browserRecord).toBe(true)
    relay.revocation(true)
    expect((await app.stop()).relayRevoked).toBe(true)
    expect(records.has(appKey)).toBe(false)
    expect(records.get(browserKey) === browserRecord).toBe(true)
    expect((await browser.stop()).relayRevoked).toBe(true)
    expect(relay.activeRooms).toBe(0)
  } finally {
    for (const phone of phones) phone.detach()
    await ctx.fiber.dispose()
    await relay.close()
  }
})

it('restores the unchanged legacy browser record and App record independently without re-enrollment', async () => {
  const relay = await mobileRelayFixture()
  const first = owner(relay.origin, relay.desktopToken)
  const browser = new FullMobileHost(first.ctx, first.config)
  let second: ReturnType<typeof owner> | undefined
  const phones: ReturnType<typeof relay.pairFull>[] = []
  try {
    const browserQR = await browser.start()
    const original = first.records.get(browserKey)
    await first.ctx.fiber.dispose()
    second = owner(relay.origin, relay.desktopToken, first.records)
    const restoredBrowser = new FullMobileHost(second.ctx, second.config), app = new FullMobileHost(second.ctx, second.config, 'app')
    await Promise.all([restoredBrowser.initialized(), app.initialized()])
    expect(app.active()).toBe(false)
    expect(relay.created).toBe(1)
    expect(second.records.get(browserKey) === original).toBe(true)
    const appQR = await app.start()
    await second.ctx.fiber.dispose()
    second = owner(relay.origin, relay.desktopToken, first.records)
    const browserAgain = new FullMobileHost(second.ctx, second.config), appAgain = new FullMobileHost(second.ctx, second.config, 'app')
    await Promise.all([browserAgain.initialized(), appAgain.initialized()])
    expect(relay.created).toBe(2)
    expect(browserAgain.active()).toBe(true)
    expect(appAgain.active()).toBe(true)
    expect(second.records.get(browserKey) === original).toBe(true)
    phones.push(relay.pairFull(browserQR.pairingUrl), relay.pairFull(appQR.pairingUrl))
    await Promise.all(phones.map(phone => phone.ready))
    expect(browserAgain.status().mobileOnline && appAgain.status().mobileOnline).toBe(true)
    await browserAgain.stop()
    expect(appAgain.status().mobileOnline).toBe(true)
    await appAgain.stop()
  } finally {
    for (const phone of phones) phone.detach()
    await first.ctx.fiber.dispose()
    await second?.ctx.fiber.dispose()
    await relay.close()
  }
})

it('rejects a browser secret when the relay delivers an App room challenge', async () => {
  const relay = await mobileRelayFixture()
  const { ctx, config } = owner(relay.origin, relay.desktopToken)
  const browser = new FullMobileHost(ctx, config), app = new FullMobileHost(ctx, config, 'app')
  let phone: ReturnType<typeof relay.pairFull> | undefined, rejected: ReturnType<typeof relay.pairFull> | undefined
  try {
    const [browserQR, appQR] = await Promise.all([browser.start(), app.start()])
    const browserFields = fragments(browserQR.pairingUrl), appFields = fragments(appQR.pairingUrl)
    const wrongKey = new MobileCipher(Buffer.from(browserFields.get('key')!, 'base64url'), appFields.get('room')!, 'mobile')
    const appHost = new MobileCipher(Buffer.from(appFields.get('key')!, 'base64url'), appFields.get('room')!)
    try { expect(() => wrongKey.open(appHost.seal({ type: 'challenge', nonce: 'synthetic' }))).toThrow() }
    finally { wrongKey.dispose(); appHost.dispose() }
    phone = relay.pairFull(browserQR.pairingUrl)
    await phone.ready
    appFields.set('key', browserFields.get('key')!)
    const mismatched = new URL(appQR.pairingUrl)
    mismatched.hash = appFields.toString()
    rejected = relay.pairFull(mismatched.href)
    await expect(rejected.ready).rejects.toThrow()
    expect(browser.status().mobileOnline).toBe(true)
    expect(phone.online).toBe(true)
    await expect(rejected.send({ type: 'fetch', id: 'wrong-room-request', url: '/', method: 'GET', headers: {} })).rejects.toThrow()
    expect(rejected.replies.length).toBe(0)
    await Promise.all([browser.stop(), app.stop()])
  } finally { phone?.detach(); rejected?.detach(); await ctx.fiber.dispose(); await relay.close() }
})

it('routes explicit App controls without cancelling legacy browser work and fails closed on invalid targets', async () => {
  const relay = await mobileRelayFixture()
  const { ctx, config } = owner(relay.origin, relay.desktopToken)
  const controller = new MobileController(ctx, config)
  try {
    await controller.start({ scope: 'instance', acknowledgeTools: true })
    const browserState = controller.status()
    await controller.start({ scope: 'instance', acknowledgeTools: true, target: 'app' })
    expect(controller.status() === browserState).toBe(true)
    expect(controller.status('browser') === browserState).toBe(true)
    for (const target of [null, '', 'APP', 'desktop', {}, false]) {
      expect(() => controller.status(target as MobilePairingTarget)).toThrow('Invalid mobile pairing target')
      expect(() => controller.start({ scope: 'instance', acknowledgeTools: true, target } as MobileStartRequest)).toThrow('Invalid mobile pairing target')
      await expect(controller.stop(target as MobilePairingTarget)).rejects.toThrow('Invalid mobile pairing target')
    }
    expect(() => controller.start({ scope: 'session', acknowledgeTools: true } as never)).toThrow('Invalid mobile authorization scope')
    expect(() => controller.start({ scope: 'instance', acknowledgeTools: false, target: 'app' } as never)).toThrow('Explicit mobile authorization')
    expect(() => controller.start({ sessionId: 'synthetic', acknowledgeTools: true, target: 'app' } as never)).toThrow('Legacy mobile authorization')
    expect(relay.created).toBe(2)
    expect((await controller.stop('app')).relayRevoked).toBe(true)
    expect(relay.activeRooms).toBe(1)
    expect(controller.status() === browserState).toBe(true)
    expect((await controller.stop()).relayRevoked).toBe(true)
    expect(controller.status('app').phase).toBe('stopped')
    expect(relay.activeRooms).toBe(0)
  } finally { await ctx.fiber.dispose(); await relay.close() }
})

it('does not let App enrollment cancel a pending legacy browser request', async () => {
  const relay = await mobileRelayFixture()
  const { ctx, config } = owner(relay.origin, relay.desktopToken)
  const controller = new MobileController(ctx, config)
  const lookup = Promise.withResolvers<{ items: never[] }>()
  ctx.provide('sessionController', { list: () => lookup.promise })
  try {
    const legacy = controller.start({ sessionId: 'synthetic' as never, acknowledgeTools: true }).then(() => false, () => true)
    await vi.waitFor(() => { expect(controller.status().phase).toBe('starting') })
    await controller.start({ scope: 'instance', acknowledgeTools: true, target: 'app' })
    expect(controller.status().phase).toBe('starting')
    await controller.stop('app')
    expect(controller.status().phase).toBe('starting')
    lookup.resolve({ items: [] })
    expect(await legacy).toBe(true)
    expect(controller.status().phase).toBe('failed')
  } finally { lookup.resolve({ items: [] }); await ctx.fiber.dispose(); await relay.close() }
})
