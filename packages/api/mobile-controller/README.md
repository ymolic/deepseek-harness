---
description: "Persistent phone device trust and encrypted access to the full Web client, for operators configuring a relay and maintainers extending transport or revocation."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-mobile-controller

English | [中文](README.zh.md)

## Summary

Pair a trusted phone with the running DSH instance and use the full Web client across networks. Sessions, settings, files, terminals and interactive approvals use the existing application services. Device trust survives Host and relay restarts until explicitly forgotten; each Session retains its existing execution permissions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web application bundle includes this controller disabled by default. In the desktop profile's `cordis.patch.yml`, set the `mobile-controller` row's `config.enabled` to `true` and `config.relayOrigin` to the exact HTTPS origin of a trusted compatible relay. Provision a separate desktop credential into the existing credential store under `DSH_MOBILE_DESKTOP_TOKEN`; never use the relay administrator key. The [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-mobile-controller) owns all configuration fields. Loopback HTTP is available for isolated tests.

The authenticated Web or Desktop client calls `mobile.start({ scope: 'instance', acknowledgeTools: true, target })` without choosing a Session. `target` is `browser` or `app`; omission preserves browser behavior. `mobile.status(target?)` and `mobile.stop(target?)` select the same independent slot. Unknown targets are rejected, never redirected to browser. Both devices may remain online; replacing or forgetting one leaves the other authorized. Consent grants full operator access, including configuration and tool approvals, rather than changing any Session's permissions.

Render the returned private URL locally as a QR code; never log it or include it in diagnostics. Browser QR URLs retain HTTPS. App QR payloads use `dshapp://host[:port]/#room=…&ticket=…&key=…&mode=full`, preserving the configured relay authority. This payload is for the App's native scanner, not OS deep-link registration; the scanner validates it and opens the corresponding HTTPS enrollment page. `mobile.status` hides enrollment material after pairing. `mobile.stop` denies that slot's local access, commits a durable revocation marker, and requests only its relay room's removal. Replacement requires confirmed removal; an unconfirmed outcome remains visible for retry.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The full-client relay creates durable device rooms through `POST /desktop/devices`, using the separate provisioning credential. Each slot owns its own `FullMobileHost`, room, secret, Peer and outbound socket. Browser trust keeps credential key `mobile-controller/trusted-device` unchanged; App trust uses `mobile-controller/trusted-app-device`, without copying or migrating the browser record. Per-room credentials authenticate outbound `/ws/device` and room revocation. Status declares protocol 2 and `full-client-e2ee`; the socket subprotocol remains `dsh-relay.v1`. Enrollment tickets expire after 120 seconds, but paired device authority has no authorization TTL. The Host stores each versioned device record in the credential provider; the relay persists only authentication digests and room metadata.

The QR fragment carries the room, ticket and a random secret. Directional HKDF keys and AES-256-GCM authenticate encrypted frames. Each reconnect exchanges fresh authenticated challenges and derives new traffic keys before accepting application operations. The relay sees timing and sizes, not application contents. The distributed phone JavaScript and both endpoints remain trusted; payload encryption does not protect against a malicious distributor or compromised endpoint.

The authenticated carrier dispatches only registered `/api/` handlers, Connection RPC channels a plugin registered under its own path, Client plugin bundles, configured frontend assets and Gateway logical streams. A channel request reaches that channel's own endpoint decoding, envelope validation and method rules with the paired device's Peer; a path no channel owns still falls through to the frontend resource reader. Mobile pairing controls are desktop-only: the carrier rejects the `mobile` API namespace over both Fetch and logical streams, so a phone cannot expose or change either slot's enrollment. It never proxies a caller-selected network destination, and a raw Web route outside `/api` and the channel registry stays unreachable from the phone. A phone service worker serves the ordinary application inside its controlled document; it holds no keys or private response cache. Acknowledged fragments bound encrypted frames, uploads and downloads stream with backpressure, and disconnect cancels active streams without replaying submitted mutations. JavaScript, CSS and SVG assets stream through gzip before encryption; private HTML and API responses are not compressed. Compressed downloads coalesce into bounded 192 KiB blocks before encrypted fragmentation.

Closing the QR dialog only hides it. Host unload closes both connections without revoking device trust. Each slot restores and reconnects independently with capped exponential delays; unavailable services remain visibly offline. Legacy Session-start requests belong only to browser and retain their short-lived projection and receipt protocol, without implementing the full-client lifecycle. App operations do not stop or supersede a legacy browser grant.

One shared window bounds concurrent download packets; `fullFragmentWindow` configures 1-32 unacknowledged fragments and defaults to 32. The Host uses the smaller configured and relay-advertised limit; older relays without that advertisement retain eight-fragment admission. Phone uploads retain an independent eight-fragment window. A compatible relay allows up to 1 MiB of full-client socket buffering, including encrypted framing, and disconnects excess buffering.

Gateway stream items retain packet order but wait only until their fragments pass the shared window and local transmitter; peer acknowledgements retire fragments independently. Each producer waits for that local write before requesting another item. When relay, Host and phone page negotiate `packet-mux-v1`, control, realtime and bulk packets share one encrypted WebSocket and one fragment-ACK window. The scheduler interleaves packets from different operations, reserves one fragment slot for control traffic, and retains order within an operation. Receivers then allow at most eight incomplete packets and 16 MiB of aggregate reassembly per connection, with a 30-second timeout. Terminal frames still wait for acknowledgement, and HTTP upload/download pulls remain unchanged. Transmit failures and ACK timeouts invalidate the matching traffic epoch; late failures from a discarded epoch cannot close its replacement on the same socket. After a hidden-to-visible transition, the phone replaces its connection once even if the old socket reports OPEN; BFCache and visibility events share that recovery. A ready iframe and its local state remain mounted; an incomplete bootstrap reloads. Async crypto completions cannot publish into a replacement connection or send with discarded keys. Read-only subscriptions obtain fresh baselines; interrupted mutations fail without automatic replay.

HTTP response headers and demanded body chunks wait for local writing rather than peer acknowledgement; response ends retain acknowledged delivery. Chunks of at most 16 KiB use control capacity; larger chunks use bulk. Senders reserve complete started packets against the receiver's aggregate reassembly limits until their last fragment is written. A near-limit packet can therefore temporarily prevent interleaving.

When binary-v1 peers also negotiate `packet-gzip-v1` with packet multiplexing, the Host compresses large Gateway stream items before encryption. `fullCompressionMinBytes` sets the minimum packet size, defaults to 32 KiB, and accepts 1 KiB through 16 MiB. Compression is used only when it reduces packet bytes. The phone checks the declared size while streaming decompression, rejects output beyond 16 MiB, and accepts only the original operation's stream item. Old Hosts, pages and relays retain uncompressed packets; no private response cache is introduced.

When the relay advertises binary support and the phone selects the Host's authenticated offer, both endpoints use binary-v1 after the legacy JSON-sealed Ready. Raw bodies, fragments and sealed envelopes avoid base64 expansion; AAD binds the complete header, traffic context and sender direction. Old peers keep JSON. Malformed declarations, mixed encodings or authentication failures close the connection without replaying operations. Download pulls remain 192 KiB, upload pulls 48 KiB, fragment payloads 12000 bytes, and Host/phone transmit guards 256 KiB; this encoding change does not enlarge windows or introduce byte credits.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [pairing UI](../../client/ui-mobile-remote/README.md), [Session Controller](../session-controller/README.md), and [full-client authorization decision](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.md).

<a id="model-experience"></a>
## Model Experience

Indirectly, through the existing Agent user-message admission path.

#### KV Cache effect

Phone actions use the same logged application operations as the Web client; the carrier adds no system prefix or tool schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The relay must support durable protocol-2 rooms. Browser cookies have browser-enforced lifetimes and can be evicted together with IndexedDB; clearing browser data requires pairing again. The Host must be running to execute operations.
- Native Electron integrations are not browser capabilities. Compose the existing browse directory-picker backend for remote directory selection. Real iPhone Safari, background suspension and cellular reliability require device acceptance.
- Packet multiplexing prevents a large logical packet from monopolizing packet scheduling, but fragments already written to the single WebSocket/TCP stream cannot be overtaken. The fragment window and per-connection reassembly limits do not bound all Gateway producer, browser consumer or multi-room relay memory. Logical streams have no application-consumption credits. Private model, Session-list and history snapshots are not persisted in the relay origin; adding such a cache requires pairing-scoped encryption, schema/version invalidation and revalidation before it can safely display stale data.

<a id="dev-note"></a>
### Dev Note

The [decision](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.md) owns authorization and recovery trade-offs. [mobile-full-client.e2e.ts](../../../apps/web/tests/mobile-full-client.e2e.ts) owns recorded application flows; [mobile-stream.e2e.ts](../../../apps/web/tests/mobile-stream.e2e.ts) checks pipelining and active-stream recovery. [mobile-transport.e2e.ts](../../../apps/web/tests/mobile-transport.e2e.ts) checks encoding and optional frozen legacy checkouts, and [mobile-transport.perf.ts](../../../apps/web/tests/mobile-transport.perf.ts) provides manual same-build JSON/binary measurements.
