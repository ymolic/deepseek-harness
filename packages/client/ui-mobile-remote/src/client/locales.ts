/** Mobile authorization copy owned by this feature. */
export const en = {
  title: 'Phone remote control', close: 'Close', select: 'Choose a session', empty: 'Open or create a session first',
  authorize: 'Pair a trusted phone', consent: 'I authorize this phone to operate this DSH instance',
  tools: 'This device receives the full Web client, including sessions, files, terminals, settings and approvals. Each session retains its existing execution permissions.',
  scope: 'Full instance access. Device trust remains until you forget the device. The single-use QR code expires in 2 minutes.',
  privacy: 'Chat payloads are encrypted between this desktop and your phone. The delivered phone page and both devices must be trusted.',
  scan: 'Scan with your phone camera and open Safari', qr: 'Private single-use pairing QR code',
  refresh: 'Refresh QR code', refreshHint: 'Refreshing revokes the previous QR code and phone authorization.',
  stop: 'Forget device', keep: 'You can close this dialog after pairing. Closing it or restarting DSH does not revoke device trust.',
  online: 'Phone connected', offline: 'Phone offline; device trust is retained',
  disabled: 'Mobile relay is not configured for this desktop', stopped: 'Remote control stopped', starting: 'Preparing authorization',
  waiting: 'Waiting for pairing', paired: 'Phone paired', reconnecting: 'Reconnecting desktop', expired: 'Authorization expired', failed: 'Remote control unavailable',
  error: 'Could not complete the operation. Check your connection and relay configuration, then retry.',
  revokeUnknown: 'Local access is stopped. Server revocation is unconfirmed; retry Forget device when the network recovers.',
  ticketExpired: 'QR code expired. Refresh it to pair a phone.', remaining: 'Authorization remaining', seconds: 's', retry: 'Retry',
} as const
/** Typed locale keys. */
export type MobileKey = keyof typeof en
/** Chinese desktop dictionary. */
export const zh: Record<MobileKey, string> = {
  title: '手机远控', close: '关闭', select: '选择要授权的会话', empty: '请先打开或创建一个会话',
  authorize: '配对受信任手机', consent: '我授权这台手机完整操作当前 DSH',
  tools: '手机将使用完整 Web 客户端，包括会话、文件、终端、设置与审批。各会话仍按原有执行权限运行',
  scope: '整机授权长期保留，手动忘记设备后失效。一次性二维码 2 分钟内有效',
  privacy: '聊天载荷在电脑与手机之间加密。请信任当前加载的手机页面及两端设备',
  scan: '用 iPhone 相机扫码，在 Safari 中打开', qr: '私密的一次性配对二维码',
  refresh: '刷新二维码', refreshHint: '刷新会撤销旧二维码及已配对手机的授权',
  stop: '忘记设备', keep: '配对后可以放心关闭弹窗；关闭弹窗或重启 DSH 都不会清除设备信任',
  online: '手机已连接', offline: '手机暂时离线，设备信任仍保留',
  disabled: '此桌面尚未配置手机中继', stopped: '远控已停止', starting: '正在准备授权',
  waiting: '等待手机配对', paired: '手机已配对', reconnecting: '桌面正在重连', expired: '授权已到期', failed: '远控暂不可用',
  error: '操作未完成。请检查网络与中继配置后重试',
  revokeUnknown: '已停止本机访问，尚未确认服务器撤销。网络恢复后请再次点击「忘记设备」',
  ticketExpired: '二维码已到期，请刷新后重新配对', remaining: '授权剩余', seconds: '秒', retry: '重试',
}
