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

The authenticated Web or Desktop client calls `mobile.start({ scope: 'instance', acknowledgeTools: true })` without choosing a Session. Consent grants full operator access, including configuration and tool approvals, rather than changing the permissions of any Session. Render the returned private URL locally as a QR code; never log it or include it in diagnostics. `mobile.status` hides enrollment material after pairing. `mobile.stop` denies local access, commits a durable revocation marker, and then requests relay removal. Replacement requires confirmed removal; an unconfirmed outcome remains visible for retry.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The full-client relay creates durable device rooms through `POST /desktop/devices`, using the separate provisioning credential. Per-room credentials authenticate outbound `/ws/device` and room revocation. Status declares protocol 2 and `full-client-e2ee`; the socket subprotocol remains `dsh-relay.v1`. Enrollment tickets expire after 120 seconds, but paired device authority has no authorization TTL. The Host stores its versioned device record in the credential provider; the relay persists only authentication digests and room metadata.

The QR fragment carries the room, ticket and a random secret. Directional HKDF keys and AES-256-GCM authenticate encrypted frames. Each reconnect exchanges fresh authenticated challenges and derives new traffic keys before accepting application operations. The relay sees timing and sizes, not application contents. The distributed phone JavaScript and both endpoints remain trusted; payload encryption does not protect against a malicious distributor or compromised endpoint.

The authenticated carrier dispatches only registered `/api/` handlers, Client plugin bundles, configured frontend assets and Gateway logical streams. It never proxies a caller-selected network destination. A phone service worker serves the ordinary application inside its controlled document; it holds no keys or private response cache. Acknowledged fragments bound encrypted frames, uploads and downloads stream with backpressure, and disconnect cancels active streams without replaying submitted mutations. JavaScript, CSS and SVG assets stream through gzip before encryption; private HTML and API responses are not compressed. Compressed downloads coalesce into bounded 192 KiB blocks before encrypted fragmentation.

Closing the QR dialog only hides it. Host unload closes connections without revoking device trust. Reconnect supervision uses capped exponential delays; unavailable services remain visibly offline. The legacy Session-start request remains for existing text clients and retains its short-lived projection and receipt protocol; it does not implement the full-client lifecycle.

One shared window bounds concurrent download packets; `fullFragmentWindow` configures 1-32 unacknowledged fragments and defaults to 32. The Host uses the smaller configured and relay-advertised limit; older relays without that advertisement retain eight-fragment admission. Phone uploads retain an independent eight-fragment window. A compatible relay allows up to 1 MiB of full-client socket buffering, including encrypted framing, and disconnects excess buffering.

Gateway stream items retain packet order but wait only until their fragments pass the shared window and local transmitter; peer acknowledgements retire fragments independently. Each producer waits for that local write before requesting another item. Terminal frames still wait for acknowledgement, and HTTP upload/download pulls remain unchanged. Transmit failures and ACK timeouts invalidate the matching traffic epoch; late failures from a discarded epoch cannot close its replacement on the same socket. After a hidden-to-visible transition, the phone replaces its connection once even if the old socket reports OPEN; BFCache and visibility events share that recovery. A ready iframe and its local state remain mounted; an incomplete bootstrap reloads. Async crypto completions cannot publish into a replacement connection or send with discarded keys. Read-only subscriptions obtain fresh baselines; interrupted mutations fail without automatic replay.

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
- The fragment window bounds unacknowledged transport bytes, not queues retained by Gateway producers or browser consumers. Logical streams have no application-consumption credits. Private model, Session-list and history snapshots are not persisted in the relay origin; adding such a cache requires pairing-scoped encryption, schema/version invalidation and revalidation before it can safely display stale data.

<a id="dev-note"></a>
### Dev Note

The [decision](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.md) owns authorization and recovery trade-offs. [mobile-full-client.e2e.ts](../../../apps/web/tests/mobile-full-client.e2e.ts) owns recorded application flows; [mobile-stream.e2e.ts](../../../apps/web/tests/mobile-stream.e2e.ts) checks pipelining and active-stream recovery. [mobile-transport.e2e.ts](../../../apps/web/tests/mobile-transport.e2e.ts) checks encoding and optional frozen legacy checkouts, and [mobile-transport.perf.ts](../../../apps/web/tests/mobile-transport.perf.ts) provides manual same-build JSON/binary measurements.
