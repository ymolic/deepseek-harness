---
description: "Web 与 Desktop 的浏览器/App 独立配对控件，涵盖整实例授权、私密二维码与设备撤销。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-mobile-remote

[English](README.md) | 中文

## 概述

Web 的「设置 → 手机远控」或 Desktop 的「更多 → 手机远控」提供「浏览器」与「DSH App」两张独立配对卡片，宽屏并列、窄屏上下排列。每卡无需选择 Session（会话）即可授权整个实例，分别管理同意、二维码、连接状态、刷新与忘记。配对或替换一端不会断开另一端，关闭弹窗不会撤销信任。

在受支持的手机连接中，点击导航状态可打开「远程连接」。重新连接保留已挂载的聊天和未发送草稿。「忘记此设备」需确认，之后须重新扫码；撤销未确认时保留可重试提示。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

Web 应用 bundle 为 Web 和 Desktop 提供此插件。配置 [Host 控制器](../../api/mobile-controller/README.zh.md)，在 Web 打开「设置 → 手机远控」，在 Desktop 打开「更多 → 手机远控」，在目标卡片确认整实例访问。会话执行权限保持不变。浏览器卡用系统相机扫码后在 Safari 打开；DSH App 卡需先打开 App 的「扫码连接」，使用 App 内扫码，不使用系统相机或 Safari。缺少中继配置时会在各卡中显示。

关闭仅隐藏弹窗，两端设备信任跨重启保留。已配对卡移除二维码。「刷新二维码」需重新勾选同意，并提示会断开、替换本卡设备信任与配对，另一端不变。「忘记此端」仅取消本卡配对与访问。服务器删除未确认时在本卡持续显示可重试提示。配对票据过期不会使已配对设备过期。

手机上的「远程连接」打开底部对齐的模态弹窗。关闭按钮、Escape 和遮罩可关闭它，不会重新连接；焦点返回状态按钮。断开、需重新配对、页面被替换及撤销未确认状态持续显示在同一导航位置。被替换的页面不能重新连接。应用和内层入口都可用之前，外层中继保留操作控件；入口消失后恢复外层控件。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

插件向 `settings.launcher.actions` 注册标准菜单行，并向 `shell.overlay` 注册共享可见状态弹窗。弹窗声明 keyed（按键区分）的 `mobile.remote.dialog.target` 子槽位，浏览器与 App 注册项分别注入独立模型与受限回调。文案由 locale 管理，界面使用已有基础组件。各模型仅串行处理自己的读取与操作，抑制变更操作后到达的过时响应，并在卸载时释放轮询和私密二维码数据。每次调用显式指定本卡 `browser` 或 `app`。二维码渲染器原样使用各自的 Host URL：Host 为 App 独立配对生成 `dshapp://host/#fragment`，UI 不从浏览器二维码转换。二维码库使用浏览器专属入口，避免将 Node 文件写入模块带入 Client bundle。

现有可信 transport 可提供可选的 `remoteControl` 回调及引用稳定的连接 observable。存在此能力时，插件仅向 `shell.navigation.actions` 注册入口，不启用桌面配对或轮询。注册项注入数据源和受限操作，通过 ref 报告已挂载按钮，并在卸载或插件 dispose（资源释放）时释放中继交接。外层页面始终拥有连接状态。旧中继不提供此能力，继续保留外层控件。

</details>

<a id="further-exploration"></a>
## 进一步探索

[设置外壳](../ui-settings-general/README.zh.md#understand-the-implementation) 拥有共享入口操作列表；[Host 控制器](../../api/mobile-controller/README.zh.md) 拥有授权与手机消息执行逻辑。

<a id="model-experience"></a>
## 模型体验

无，因为此插件只展示授权和连接控件，不提供模型输入。

#### KV Cache 影响

弹窗状态和二维码渲染不改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 二维码是私密配对材料，不得包含在截图或诊断信息中；已配对状态不得重新渲染二维码。
- 此弹窗管理信任；完整手机 Web 客户端负责会话、审批、附件、终端和工作区交互。

<a id="dev-note"></a>
### 开发备注

[授权决策](../../../.agents/notes/implemented/architecture/2026-10-15-persistent-full-mobile-client.zh.md) 记录范围和生命周期要求。
