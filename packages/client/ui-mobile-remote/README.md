---
description: "Web and Desktop controls for independent browser and App pairing, full-instance consent, private QR display and device revocation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

English | [中文](README.zh.md)

## Summary

Settings → Phone remote control in Web, or More → Phone remote control in Desktop, provides separate Browser and DSH App pairing cards, side by side on wide screens and stacked on narrow screens. Each grants whole-instance access without selecting a Session, with independent consent, QR code, connection status, refresh and forget actions. Pairing or replacing one client does not disconnect the other. Closing the dialog does not revoke trust.

On a supported phone connection, the navigation status opens Remote connection. Reconnect retains the mounted chat and unsent draft. Forget this device requires confirmation and a new scan afterward; unconfirmed revocation stays visible with a retry action.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web application bundle includes the plugin for both Web and Desktop. Configure the [Host controller](../../api/mobile-controller/README.md), open Settings → Phone remote control in Web or More → Phone remote control in Desktop, and acknowledge full-instance access in the intended card. Session execution permissions remain unchanged. For Browser, scan with the system Camera and open Safari. For DSH App, open the App's Scan to connect screen and use its in-app scanner, not the system Camera or Safari. A missing relay configuration appears in each card.

Close hides the dialog while both clients' device trust continues across restarts. A paired card removes its QR. Refresh QR code requires a fresh acknowledgement and warns that it disconnects and replaces only that card's trust and enrollment; the other client remains unchanged. Forget this client cancels only that enrollment and access. Unconfirmed server removal stays visible in its card for retry. Enrollment expiry does not expire an already paired device.

On the phone, Remote connection opens a bottom-aligned modal. Close, Escape and the backdrop dismiss it without reconnecting; focus returns to the status button. Disconnected, pairing-required, replaced-page and uncertain-revocation states remain in that same navigation position. A replaced page cannot reconnect. The outer relay retains its controls until the application and the inner entry are both usable, and restores them when the entry disappears.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes a standard menu row to `settings.launcher.actions` and a shared-visibility dialog to `shell.overlay`. The dialog declares the keyed `mobile.remote.dialog.target` child slot; browser and App registrations inject separate models and restricted callbacks. Locale-owned copy and existing primitives supply presentation. Each model serializes only its own reads and operations, suppresses stale responses after mutations, and releases polling and private QR data on unload. Calls include its explicit `browser` or `app` target. The QR renderer uses each Host-issued URL verbatim: the Host issues the App-specific `dshapp://host/#fragment` URL with its own enrollment, never a UI conversion of the browser QR. The browser-specific QR library entry prevents Node file writers from entering the Client bundle.

The existing trusted transport may expose optional `remoteControl` callbacks and an identity-stable connection observable. In that case the plugin contributes only a `shell.navigation.actions` entry, not desktop enrollment or polling. The registration injects the source and restricted actions; its ref reports the mounted button and releases the relay handoff on unmount or plugin disposal. The outer shell remains the connection owner. Older relays omit this capability and retain their outer controls.

</details>

<a id="further-exploration"></a>
## Further Exploration

The [settings shell](../ui-settings-general/README.md#understand-the-implementation) owns the shared launcher action list; the [Host controller](../../api/mobile-controller/README.md) owns authorization and phone execution.

<a id="model-experience"></a>
## Model Experience

None, as this plugin displays authorization and connection controls without contributing model input.

#### KV Cache effect

Dialog state and QR rendering do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The QR code is private enrollment material. Never include it in screenshots or diagnostics; paired status must not render it again.
- This dialog manages trust; the full phone Web client owns sessions, approvals, attachments, terminals and workspace interaction.

<a id="dev-note"></a>
### Dev Note

The [authorization decision](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.md) records the scope and lifecycle requirements.
