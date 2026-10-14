---
description: "桌面更多菜单与手机控制的明确 Session 授权，涵盖私密二维码显示、刷新、停止和可恢复错误。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

[English](README.md) | 中文

## 概述

「更多 → 手机远控」让桌面操作者选择一个 Session（会话），确认其已有工具权限，并显示本地生成的一次性二维码。授权在 Host 中执行；此 Client 仅负责临时展示。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 包含该插件；UI 仅在 Desktop 中启用。配置 [Host 控制器](../../api/mobile-controller/README.zh.md)，打开「更多 → 手机远控」，选择已有 Session，并确认消息可以使用其当前工具。用手机相机扫描二维码，打开可信的手机页面。缺少中继配置时会在弹窗中显示。

关闭仅隐藏弹窗，授权仍然有效。刷新二维码先撤销旧手机及票据，再创建新授权。停止远控取消正在准备的授权并停止访问。服务器撤销失败时保留可见提示和停止操作，以便重试。过期二维码会从视图中清除；配对手机不会延长授权期限。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件向 `settings.launcher.actions` 注册标准菜单行，并向 `shell.overlay` 注册共享状态弹窗。文案由 locale 管理，界面使用已有基础组件和 Session 目录。模型串行读取状态，抑制变更操作之后到达的过时响应，并在卸载时释放轮询和私密二维码数据。它在启用时捕获生成的 Remote 命名空间。二维码库使用浏览器专属入口，避免将 Node 文件写入模块带入 Client bundle。

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

- 二维码是私密临时材料，Client 重载后不可恢复；需刷新授权以获得新码。不得在截图或诊断信息中包含有效二维码。
- 此界面不支持手机审批、附件、终端或工作区管理。

<a id="dev-note"></a>
### 开发备注

[授权决策](../../../.agents/notes/implemented/architecture/2026-10-15-session-scoped-mobile-control.zh.md) 记录范围和生命周期要求。
