# Agent Note: Persistent Full Mobile Client

Status: implemented

English | [中文](2026-10-15-persistent-full-mobile-client.zh.md)

## Problem

The separate text phone interface omits application features and duplicates menus, rendering and recovery behavior. Session selection and short authorization prevent using the phone as a continuing operator client. A paired QR still visible on Desktop makes closing the dialog appear unsafe.

## Decision

Explicit instance consent authorizes the existing Web client over an encrypted outbound carrier. The Host dispatches registered application handlers and Gateway streams, not arbitrary destination URLs. The ordinary Client owns models, permissions, sessions, attachments and interactions; the carrier does not implement a second set of application operations. This supersedes the default scope of [Session-scoped mobile control](2026-10-15-session-scoped-mobile-control.md), whose legacy projection and bounded receipt rationale remain relevant to its compatibility path.

The credential provider owns a versioned device record. The relay durably stores authentication digests and room metadata, never traffic keys or payloads. Host unload disconnects but does not revoke. Manual forgetting denies local work before durable revocation and network deletion; an unconfirmed deletion stays visible and cannot silently become new authority after restart.

Enrollment uses a short-lived single-use ticket. Paired authority has no application TTL. The browser stores a nonextractable root key and its HttpOnly cookie; browser eviction or cookie policy can still require pairing again. Fresh root-authenticated challenges derive traffic keys on every connection and peer replacement. Directional sequences and request IDs reject replay within an epoch; uncertain mutations are failed visibly and never automatically resent.

The pairing page owns keys and a controlled same-origin application document. Its service worker forwards asset and native HTTP requests without retaining keys or private response caches. Packet acknowledgements and demand-driven binary transfer bound outstanding data. Worker restart can rediscover the owning page without storing credentials.

Desktop-only account implementation and onboarding artwork load through a package-local async chunk after detecting the native bridge; ordinary browsers do not download that chunk. Download flight size is deployment-configured up to 32 fragments, with a relay buffer cap that covers the encrypted flight. Upload limits, fragment sizes, response demand and wire acknowledgements remain unchanged. A hidden-to-visible cycle replaces the phone connection once rather than trusting an OPEN socket as evidence of application progress. Recovery retains a ready application document, reloads incomplete bootstrap and rejects late crypto work from discarded connections. These choices remove unused startup bytes and reduce acknowledgement waits without weakening authorization or caching private responses.

## Alternatives considered

**Extend the separate phone UI** duplicates every Web capability and its lifecycle. Reusing the shipped Client preserves working application interactions and reduces divergence.

**Generic network tunneling** exposes destinations unrelated to the authorized instance. Dispatch to registered routes, bundles, frontend assets and typed streams retains application validation.

**Non-expiring enrollment links** turn copied URLs into permanent login material. Short single-use enrollment and durable paired identity separate scanning from continuing trust.

**Replay pending mutations after reconnect** can repeat an operation whose acknowledgement was lost. Reopen read streams and retain the application's existing receipt semantics instead.

**Cache private responses to speed startup** introduces authority isolation and invalidation obligations. Removing unused Desktop assets and widening a bounded download flight address measured transfer costs without retaining application data.

## Consequences

Full-instance consent grants operator authority, including sensitive configuration and tool approval. It does not convert Sessions to full-access execution mode. Native desktop integrations remain desktop-only; the existing browse picker serves remote directory selection. The distributor and both endpoints remain trusted despite payload encryption.

Loader tests cover instance enrollment, registered RPC and streams, persistence on unload and explicit revocation. Browser acceptance uses the deployable relay and a recorded Session. Chromium emulation does not establish iPhone Safari, cellular or long-running background acceptance.
