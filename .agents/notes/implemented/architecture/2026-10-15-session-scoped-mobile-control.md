# Agent Note: Session-scoped mobile control

Status: implemented

English | [中文](2026-10-15-session-scoped-mobile-control.zh.md)

## Problem

A phone needs to exchange text with an explicitly selected desktop Session across networks. The existing authenticated Client has broad operator authority, and relaying its generic Remote calls would grant more access than the selected Session permits. Transport interruption also makes a successful send indistinguishable from a lost acknowledgement.

## Decision

The [mobile controller](../../../../packages/api/mobile-controller/README.md) owns a short-lived grant to the same Agent instance. The phone receives only bounded user and assistant text and can send text or query state and receipts. The existing Agent, permission services, and durable Session admission remain the execution authority; the phone cannot alter the grant's Session, paths, permissions, or method set. Approvals and questions stay on the desktop.

An independent provisioned desktop credential creates relay rooms. A single-use QR fragment carries ephemeral pairing material and an encryption secret; the relay never receives the secret. Direction-specific HKDF keys and authenticated AES-GCM envelopes keep passive relay operators from reading conversation payloads. The page distributor and endpoints remain trusted, so this does not claim protection from a relay operator replacing the served JavaScript.

The Host retains request IDs and admission outcomes for the complete grant, without evicting receipts and rerunning an older ID. Unknown outcomes remain unknown. Reconnect uses a new authenticated browser channel and a bounded replacement snapshot instead of replaying generic RPC traffic. Stop denies admission synchronously, clears local resources, and reports whether the relay confirmed revocation; a later explicit Stop retries an uncertain revocation. Start does not replace such a grant until revocation is confirmed.

## Alternatives considered

**Generic operator RPC forwarding** would reuse the existing Client transport but would expose workspace, filesystem, and management methods outside phone consent. A restricted executor makes scope enforceable independently of the phone UI.

**TLS alone** protects network hops but permits the relay to read chat contents. Payload encryption provides a useful narrower guarantee while retaining the explicit trust requirement for the delivered page.

**Automatic send retry or receipt eviction** can execute a message twice after acknowledgement loss. Receipt lookup and an explicit same-ID retry only after a not-seen result preserve the original admission decision. Bounded grants and receipt counts keep this state finite.

**General fragmented RPC replay** adds reassembly, retention, and backpressure obligations for operations the phone cannot use. Bounded complete text snapshots recover the required view; large histories and arbitrary binary payloads are deliberately omitted.

## Consequences

The shipped Loader composition exercises real Agent admission, recorded replies, duplicate IDs, revocation retry, and plugin disposal. Browser checks cover consent and QR lifecycle. Unit checks reject authority fields, forged envelopes, gaps, replay, and stale publication. Deployment acceptance still needs a compatible relay; Chromium mobile emulation cannot establish iPhone Safari behavior or network reliability.

The grant expires within ten minutes, cannot survive Host restart, and supports a single Session. A disconnected desktop cannot accept phone commands. A network partition can prevent confirmed relay deletion, but cannot make a locally revoked Agent accept another request. These limits belong to DSH's design and are not claims about any reference application's server behavior.
