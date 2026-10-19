---
description: "为配置中继的操作者和扩展传输或撤销机制的维护者说明：持久手机设备信任与完整 Web 客户端的加密访问。"
kind: "package-reference"
---

# @deepseek-ai/dsh-api-mobile-controller

[English](README.md) | 中文

## 概述

将受信任手机与当前 DSH 实例配对，跨网络使用完整 Web 客户端。会话、设置、文件、终端和交互式审批使用现有应用服务。设备信任跨 Host 和中继重启保留，直到手动忘记；各 Session（会话）仍按原有执行权限运行。

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

已认证 Web 或 Desktop 客户端调用 `mobile.start({ scope: 'instance', acknowledgeTools: true })`，无需选择 Session。授权授予包括配置和工具审批在内的完整操作者访问，不改变任何 Session 的权限。返回的私密 URL 仅在本地渲染为二维码，不得记录或写入诊断信息。配对后 `mobile.status` 隐藏配对材料。`mobile.stop` 先拒绝本机访问并持久提交撤销标记，再请求中继删除。替换授权要求确认删除；未确认结果持续可见并可重试。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

完整客户端中继通过 `POST /desktop/devices` 使用独立配置凭据创建持久设备房间。房间专属凭据认证出站 `/ws/device` 和房间撤销。状态声明协议 2 与 `full-client-e2ee`，socket 子协议仍为 `dsh-relay.v1`。配对票据 120 秒过期，已配对设备权限没有授权 TTL。Host 在凭据服务中保存带版本的设备记录；中继仅持久化认证摘要和房间元数据。

二维码 fragment 携带房间、票据和随机秘密。分方向 HKDF 密钥与 AES-256-GCM 认证加密帧。每次重连交换新的已认证挑战，并在接受应用操作前派生新流量密钥。中继可见时间和大小，但不能读取应用内容。分发的手机 JavaScript 和两端设备仍须可信；载荷加密无法防护恶意分发者或已失陷端点。

已认证传输仅分派已注册 `/api/` handler、Client 插件 bundle、已配置前端资产和 Gateway 逻辑流，不代理调用者指定的网络目标。手机 service worker 在受控文档内提供原有应用，不持有密钥或私密响应缓存。带确认的分片约束加密帧，上传和下载按背压流式处理，断线取消活动流而不重放已提交变更。JavaScript、CSS 和 SVG 资产在加密前以 gzip 流式压缩；私密 HTML 与 API 响应不压缩。压缩下载在加密分片前合并为最多 192 KiB 的有界块。

关闭二维码弹窗仅隐藏界面。Host 卸载只关闭连接，不撤销设备信任。重连监督使用有上限的指数退避；服务不可用时持续显示离线。旧 Session-start 请求为已有文本客户端保留，继续使用短期投影与回执协议，不实现完整客户端生命周期。

所有并发下载包共用有界窗口；`fullFragmentWindow` 配置未确认分片数，范围 1-32，默认 32。Host 采用配置与中继声明两者中较小的限制；未声明窗口的旧中继仍限八分片。手机上传保留独立的八分片窗口。兼容中继允许包含加密封装在内最多 1 MiB 的完整客户端 socket 缓冲，超限即断开。单分片限制、按需响应块与取消机制不变；确认回执分别完成各次发送，不要求每个包之间再等待一次网络往返。

当中继声明二进制支持，且手机选择 Host 已认证的能力提议时，两端在旧格式 JSON 加密的 Ready 之后使用 binary-v1。原始 body、分片和加密信封避免 base64 放大；AAD 绑定完整头字段、流量上下文和发送方向。旧端继续使用 JSON。畸形声明、混用编码或认证失败会关闭连接，不重放操作。下载拉取仍为 192 KiB，上传拉取为 48 KiB，分片载荷为 12000 字节，Host/手机发送检查仍为 256 KiB；此编码改造不扩大窗口或引入字节授信。

</details>

<a id="further-exploration"></a>
## 进一步探索

参见[配对 UI](../../client/ui-mobile-remote/README.zh.md)、[Session Controller](../session-controller/README.zh.md) 和[完整客户端授权决策](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.zh.md)。

<a id="model-experience"></a>
## 模型体验

间接通过现有 agent 用户消息接收路径影响模型。

#### KV Cache 影响

手机操作使用 Web 客户端同一组带日志的应用操作；传输不增加系统前缀或工具 schema。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 中继必须支持持久协议 2 房间。浏览器 cookie 受浏览器有效期限制，也可能与 IndexedDB 一起被清除；清理浏览器数据后需要重新配对。Host 必须运行才能执行操作。
- 原生 Electron 集成不是浏览器能力。远端目录选择需组合现有 browse 目录选择后端。真实 iPhone Safari、后台挂起与蜂窝网络可靠性需真机验收。

<a id="dev-note"></a>
### 开发备注

[决策](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.zh.md) 维护授权与恢复取舍。[mobile-full-client.e2e.ts](../../../apps/web/tests/mobile-full-client.e2e.ts) 维护录制应用流程；[mobile-transport.e2e.ts](../../../apps/web/tests/mobile-transport.e2e.ts) 检查编码与可选的冻结旧版 checkout，[mobile-transport.perf.ts](../../../apps/web/tests/mobile-transport.perf.ts) 提供同构建 JSON/二进制手动测量。
