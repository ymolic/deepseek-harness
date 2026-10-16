---
description: "Web and Desktop pairing controls for full-instance phone consent, private QR display, persistent device status and explicit revocation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

English | [中文](README.zh.md)

## Summary

More → Phone remote control pairs a trusted phone with the whole DSH instance, without selecting a Session. The locally generated QR disappears after pairing. The dialog shows connection status and lets the operator forget the device; closing it does not revoke trust.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web application bundle includes the plugin for both Web and Desktop. Configure the [Host controller](../../api/mobile-controller/README.md), open More → Phone remote control, and acknowledge full-instance operator access. Session execution permissions remain unchanged. Scan the QR code with the phone camera and open the trusted phone page. A missing relay configuration appears in the dialog.

Close hides the dialog while device trust continues across restarts. Before pairing, Refresh QR code revokes the preceding enrollment before creating a new one. After pairing, the dialog removes the QR and refresh action. Forget device cancels enrollment and stops access. Unconfirmed server removal remains visible for retry. Enrollment expiry does not expire an already paired device.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes a standard menu row to `settings.launcher.actions` and a shared-store dialog to `shell.overlay`. Locale-owned copy and existing primitives supply presentation. The model serializes status reads, suppresses stale responses after mutations, and releases polling and private QR data on unload. It captures the generated Remote namespace at activation. The browser-specific QR library entry prevents Node file writers from entering the Client bundle.

</details>

<a id="further-exploration"></a>
## Further Exploration

The [account menu](../ui-settings-account/README.md) owns the launcher slot; the [Host controller](../../api/mobile-controller/README.md) owns authorization and phone execution.

<a id="model-experience"></a>
## Model Experience

None, as this plugin displays desktop authorization controls without contributing model input.

#### KV Cache effect

Dialog state and QR rendering do not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The QR code is private enrollment material. Never include it in screenshots or diagnostics; paired status must not render it again.
- This dialog manages trust; the full phone Web client owns sessions, approvals, attachments, terminals and workspace interaction.

<a id="dev-note"></a>
### Dev Note

The [authorization decision](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.md) records the scope and lifecycle requirements.
