---
description: "Desktop authorization and encrypted phone text control for one existing Session, for operators configuring a relay and maintainers extending admission or recovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-mobile-controller

English | [中文](README.zh.md)

## Summary

The desktop authorizes one existing Session for phone text access. The Host connects outbound to a configured relay, projects recent conversation text, and admits phone messages through the existing Agent with its current permissions.

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

The authenticated desktop calls `mobile.status`, `mobile.start`, and `mobile.stop`. Start requires an available, unarchived Session and explicit acknowledgement that phone messages can use its existing tools. The returned pairing URL is private transient data: render it locally as a QR code and never log, persist, copy into diagnostics, or send it to a model. Closing the dialog leaves authorization active. Start replaces an existing grant only after confirmed relay revocation; Stop denies local admission before awaiting relay acknowledgement and exposes an unconfirmed outcome for retry.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The relay creates a room through `POST /desktop/rooms` using the provisioned desktop credential. Per-room credentials authenticate outbound `/ws/device` and `POST /device/rooms/:id/revoke`. Both roles use the `dsh-relay.v1` WebSocket subprotocol and `session-chat-e2ee` mode. A compatible relay enforces a 120-second single-use ticket and at most ten minutes of authorization measured from room creation. The Host also enforces a monotonic deadline and checks the same Agent instance and archive state at every admission.

The QR fragment carries the room, ticket, and a random 32-byte secret. HKDF-SHA256 derives separate desktop, mobile, and browser-storage keys with the room as salt and `dsh-mobile/v1/{direction}` as info. AES-256-GCM uses random 12-byte IVs and authenticates room, direction, generation, and sequence. The relay forwards opaque envelopes; it still sees timing and sizes. The delivered phone JavaScript and both endpoints remain trusted. TLS and payload encryption do not protect against a malicious page distributor or a compromised endpoint.

The encrypted protocol supports hello, sync, text send, and receipt lookup, as well as mobile capability protocol extensions: workspace list/switch, rich conversation snapshots with formatted tool cards, cancellation, tool execution approval responses, and user question answers. All requests are validated against strict exact-key allowlists without generic RPC tunneling. Generations and sequence checks reject gaps and replay. A grant retains up to 256 request receipts without eviction: duplicate IDs return the original admission outcome, and different text under an existing ID conflicts. An uncertain admission remains uncertain and is never executed again automatically. Full bounded text and rich block snapshots recover missed stream updates without an unbounded RPC replay buffer.

Stop, expiry, Session disposal, and plugin unload release streams, sockets, keys, receipts, and timers. Temporary transport failures permit three retries, with the budget restored only after thirty stable seconds. Existing approvals and questions remain desktop work. System prompts, reasoning, tool payloads, and injected user messages are excluded from the phone projection.

</details>

<a id="further-exploration"></a>
## Further Exploration

See the [desktop UI](../../client/ui-mobile-remote/README.md), [Session Controller](../session-controller/README.md), and [authorization decision](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.md).

<a id="model-experience"></a>
## Model Experience

Indirectly, through the existing Agent user-message admission path.

#### KV Cache effect

Phone text appends ordinary user messages; this controller adds no system prefix or tool schema.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Mobile roaming is bounded to host workspaces and sessions; raw terminals, arbitrary host file traversal, and credential inspection remain strictly restricted.
- Neither endpoint persists grants across Host restart. A disconnected phone can recover only while the original grant remains valid; network failure can delay confirmation of server revocation, but cannot restore local admission.

<a id="dev-note"></a>
### Dev Note

The [decision](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.md) owns the limits and recovery trade-offs. Loader composition and browser checks are in [mobile-remote.e2e.ts](../../../apps/web/tests/mobile-remote.e2e.ts).
