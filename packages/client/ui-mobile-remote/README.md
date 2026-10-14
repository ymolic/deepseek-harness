---
description: "Desktop More menu and explicit Session consent for phone control, including private QR display, refresh, stop, and recoverable errors."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

English | [中文](README.zh.md)

## Summary

More → Phone remote control lets the desktop operator select one Session, acknowledge its existing tool permissions, and display a locally generated single-use QR code. Authorization runs in the Host; this Client owns only transient presentation.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The Web application bundle includes the plugin; its UI activates only in Desktop. Configure the [Host controller](../../api/mobile-controller/README.md), open More → Phone remote control, select an existing Session, and acknowledge that messages can use its current tools. Scan the QR code with the phone camera and open the trusted phone page. A missing relay configuration appears in the dialog.

Close hides the dialog while authorization continues. Refresh QR code revokes the previous phone and ticket before creating a new grant. Stop remote control cancels pending authorization and stops access. A failed server revocation remains visible with a Stop action for retry. Expired QR material is cleared from view; a paired phone does not extend the grant's deadline.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin contributes a standard menu row to `settings.launcher.actions` and a shared-store dialog to `shell.overlay`. Locale-owned copy, existing primitives, and the Session catalog supply presentation. The model serializes status reads, suppresses stale responses after mutations, and releases polling and private QR data on unload. It captures the generated Remote namespace at activation. The browser-specific QR library entry prevents Node file writers from entering the Client bundle.

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

- The QR code is private, transient material. It is unavailable after Client reload; refresh the grant to obtain a new code. Never include a live QR code in screenshots or diagnostics.
- Phone approvals, attachments, terminals, and workspace management are outside this interface.

<a id="dev-note"></a>
### Dev Note

The [authorization decision](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.md) records the scope and lifecycle requirements.
