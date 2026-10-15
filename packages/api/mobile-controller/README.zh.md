---
description: "为配置中继的操作者和扩展消息接收或恢复机制的维护者说明：桌面对单个已有 Session 的授权与手机加密文本控制。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-mobile-controller

[English](README.md) | 中文

## 概述

桌面授权手机访问一个已有 Session（会话）的文本。Host 向配置的中继发起出站连接，投影近期对话文本，并通过现有 agent（智能体）按其当前权限接收手机消息。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 包含此控制器，默认禁用。在桌面 profile 的 `cordis.patch.yml` 中，将 `mobile-controller` 行的 `config.enabled` 设为 `true`，并将 `config.relayOrigin` 设为可信兼容中继的精确 HTTPS origin。通过已有凭据存储单独配置 `DSH_MOBILE_DESKTOP_TOKEN`；不要使用中继管理密钥。[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-api-mobile-controller) 维护所有配置字段。隔离测试可使用 loopback HTTP。

已认证桌面调用 `mobile.status`、`mobile.start` 和 `mobile.stop`。Start 要求 Session 可用且未归档，并明确确认手机消息可以使用它已有的工具。返回的配对 URL 是私密临时数据：仅在本地生成二维码，不得记录、持久化、复制到诊断信息或发送给模型。关闭弹窗保留授权。Start 只有在确认中继撤销后才替换已有授权；Stop 在等待中继确认前先拒绝本机接收，并暴露未确认状态以便重试。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

中继通过 `POST /desktop/rooms` 使用已配置的桌面凭据创建房间。房间专属凭据认证出站 `/ws/device` 和 `POST /device/rooms/:id/revoke`。两端都使用 `dsh-relay.v1` WebSocket 子协议和 `session-chat-e2ee` 模式。兼容中继强制执行 120 秒一次性票据，以及从房间创建开始计算、最长十分钟的授权。Host 同时执行单调时钟期限，并在每次接收消息时检查同一个 agent 实例及归档状态。

二维码 fragment 携带房间、票据和随机 32 字节秘密。HKDF-SHA256 使用房间作为 salt、`dsh-mobile/v1/{direction}` 作为 info，派生桌面、手机和浏览器存储的独立密钥。AES-256-GCM 使用随机 12 字节 IV，并认证房间、方向、代次和序号。中继转发不透明封装，仍可看到时间和大小。下发的手机 JavaScript 及两端设备必须可信。TLS 和载荷加密无法防护恶意页面分发者或已失陷的端点。

加密协议支持 hello、同步、文本发送和回执查询，以及扩展的移动能力协议：工作区与会话列表/切换、包含折叠工具卡片的富文本快照、生成中止、工具审批确认与结构化问题回答。所有手机请求均通过严格的精确字段白名单校验，拒绝通用 RPC 隧道穿透。代次和序号检查拒绝缺口与重放。每次授权最多保留 256 条请求回执且不淘汰：重复 ID 返回原始接收结果，同一 ID 下的不同文本冲突。不确定的接收结果保持不确定，绝不自动再次执行。完整且有界的文本与结构化卡片快照用于恢复漏收的流更新，无需无界 RPC 重放缓存。

停止、到期、Session 释放和插件卸载会释放流、连接、密钥、回执及定时器。临时连接失败允许三次重试，只有稳定三十秒才恢复预算。已有审批和问题仍交由桌面处理。手机投影排除系统提示、推理、工具载荷和注入的用户消息。

</details>

<a id="further-exploration"></a>
## 进一步探索

参见[桌面 UI](../../client/ui-mobile-remote/README.zh.md)、[Session Controller](../session-controller/README.zh.md) 和[授权决策](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.zh.md)。

<a id="model-experience"></a>
## 模型体验

间接通过现有 agent 用户消息接收路径影响模型。

#### KV Cache 影响

手机文本追加为普通用户消息；此控制器不增加系统前缀或工具 schema。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 移动端漫游严格受限于宿主工作区和会话；系统级终端、任意宿主文件遍历和凭据读取保持严格限制。
- 两端均不支持授权跨 Host 重启保留。断线手机只能在原授权仍有效时恢复；网络失败可能延迟服务器撤销的确认，但不能恢复本机接收权限。

<a id="dev-note"></a>
### 开发备注

[决策](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.zh.md) 维护限制与恢复取舍。Loader 组合和浏览器检查位于 [mobile-remote.e2e.ts](../../../apps/web/tests/mobile-remote.e2e.ts)。
