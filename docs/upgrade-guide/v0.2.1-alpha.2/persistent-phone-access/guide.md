---
kind: upgrade-guide
description: "Phone pairing now grants persistent instance-wide Web access instead of requiring a short-lived Session selection."
---

# Persistent Full Phone Access

English | [中文](guide.zh.md)

## Change

The pairing dialog no longer selects one Session. It explicitly authorizes the complete Web client for this instance, including settings, files, terminals and approvals. Session execution permissions do not change. Device trust survives Host and relay restarts; the single-use enrollment ticket still expires. Closing the dialog does not disconnect the phone, and paired state removes the QR code.

The relay no longer serves the standalone text UI or `/app.js`. Old text grants require full-access pairing, but upgrading does not delete browser records. Protocol-1 wire compatibility remains available to existing consumers. Connection status reports loading until the actual Web application mounts; failed startup offers Reload without clearing device trust.

## Migration

1. Upgrade the relay to support `POST /desktop/devices`, protocol 2, `full-client-e2ee`, and protected durable storage. Preserve that storage during upgrades; a legacy in-memory relay cannot restore device trust.
2. Rebuild and restart the existing DSH entry point. Keep `mobile-controller.config.enabled`, `relayOrigin` and the separate `DSH_MOBILE_DESKTOP_TOKEN`; do not expose the relay administrator credential.
3. Compose the existing browse directory-picker backend and surface when phone users need to select Host directories. Native Electron integrations remain desktop-only.
4. Open Phone remote control, acknowledge instance-wide access, and pair again when upgrading a legacy text grant. Existing full-instance devices retain their trust when relay storage and browser data are preserved.
5. Confirm the QR disappears, the full Web client loads, and refresh and Host restart preserve access. Use Forget device to revoke it; retry when server revocation remains unconfirmed. Browser data eviction or manual clearing requires pairing again.
