---
description: "Web 与 Desktop 的整实例手机授权控件，涵盖私密二维码、持久设备状态和明确撤销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

[English](README.md) | 中文

## 概述

「更多 → 手机远控」将受信任手机与整个 DSH 实例配对，无需选择 Session（会话）。本地生成的二维码在配对后消失。弹窗显示连接状态并允许操作者忘记设备，关闭它不会撤销信任。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 为 Web 和 Desktop 提供此插件。配置 [Host 控制器](../../api/mobile-controller/README.zh.md)，打开「更多 → 手机远控」，确认整实例操作者访问。会话执行权限保持不变。用手机相机扫描二维码，打开可信手机页面。缺少中继配置时会在弹窗中显示。

关闭仅隐藏弹窗，设备信任跨重启保留。配对前，刷新二维码先撤销上一轮配对，再创建新配对。配对后弹窗移除二维码和刷新操作。忘记设备取消配对并停止访问。服务器删除未确认时持续显示可重试提示。配对票据过期不会使已配对设备过期。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件向 `settings.launcher.actions` 注册标准菜单行，并向 `shell.overlay` 注册共享状态弹窗。文案由 locale 管理，界面使用已有基础组件。模型串行读取状态，抑制变更操作之后到达的过时响应，并在卸载时释放轮询和私密二维码数据。它在启用时捕获生成的 Remote 命名空间。二维码库使用浏览器专属入口，避免将 Node 文件写入模块带入 Client bundle。

</details>

<a id="further-exploration"></a>
## 进一步探索

[账号菜单](../ui-settings-account/README.zh.md) 拥有 launcher slot；[Host 控制器](../../api/mobile-controller/README.zh.md) 拥有授权与手机消息执行逻辑。

<a id="model-experience"></a>
## 模型体验

无，因为此插件只展示桌面授权控件，不提供模型输入。

#### KV Cache 影响

弹窗状态和二维码渲染不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 二维码是私密配对材料，不得包含在截图或诊断信息中；已配对状态不得重新渲染二维码。
- 此弹窗管理信任；完整手机 Web 客户端负责会话、审批、附件、终端和工作区交互。

<a id="dev-note"></a>
### 开发备注

[授权决策](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.zh.md) 记录范围和生命周期要求。
