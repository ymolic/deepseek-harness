/** Mobile authorization copy owned by this feature. */
export const en = {
  title: 'Phone remote control', close: 'Close', select: 'Choose a session', empty: 'Open or create a session first',
  authorize: 'Authorize and show QR code', consent: 'I authorize this phone to read and send text in this session',
  tools: 'Phone messages can run this session’s existing tools with its current permissions. Approvals and questions must be handled on the desktop.',
  scope: 'One session · up to 10 minutes · single-use QR code expires in 2 minutes',
  privacy: 'Chat payloads are encrypted between this desktop and your phone. The delivered phone page and both devices must be trusted.',
  scan: 'Scan with your phone camera and open Safari', qr: 'Private single-use pairing QR code',
  refresh: 'Refresh QR code', refreshHint: 'Refreshing revokes the previous QR code and phone authorization.',
  stop: 'Stop remote control', keep: 'Closing this dialog keeps the authorization active. Use Stop remote control to revoke it.',
  disabled: 'Mobile relay is not configured for this desktop', stopped: 'Remote control stopped', starting: 'Preparing authorization',
  waiting: 'Waiting for pairing', paired: 'Phone paired', reconnecting: 'Reconnecting desktop', expired: 'Authorization expired', failed: 'Remote control unavailable',
  error: 'Could not complete the operation. Check your connection and relay configuration, then retry.',
  revokeUnknown: 'Local access is stopped. Server revocation is unconfirmed; retry Stop when the network recovers.',
  ticketExpired: 'QR code expired. Refresh it to pair a phone.', remaining: 'Authorization remaining', seconds: 's', retry: 'Retry',
} as const
/** Typed locale keys. */
export type MobileKey = keyof typeof en
/** Chinese desktop dictionary. */
export const zh: Record<MobileKey, string> = {
  title: '手机远控', close: '关闭', select: '选择要授权的会话', empty: '请先打开或创建一个会话',
  authorize: '授权并生成二维码', consent: '我授权手机查看此会话的文本内容并发送消息',
  tools: '手机发送的消息可能调用此会话已有工具，并按当前权限执行。需要审批或回答问题时，请回到桌面处理',
  scope: '仅此会话 · 授权最长 10 分钟 · 二维码 2 分钟内仅可使用一次',
  privacy: '聊天载荷在电脑与手机之间加密。请信任当前加载的手机页面及两端设备',
  scan: '用 iPhone 相机扫码，在 Safari 中打开', qr: '私密的一次性配对二维码',
  refresh: '刷新二维码', refreshHint: '刷新会撤销旧二维码及已配对手机的授权',
  stop: '停止远控', keep: '关闭弹窗会保留授权；点击「停止远控」才会撤销',
  disabled: '此桌面尚未配置手机中继', stopped: '远控已停止', starting: '正在准备授权',
  waiting: '等待手机配对', paired: '手机已配对', reconnecting: '桌面正在重连', expired: '授权已到期', failed: '远控暂不可用',
  error: '操作未完成。请检查网络与中继配置后重试',
  revokeUnknown: '已停止本机访问，尚未确认服务器撤销。网络恢复后请再次点击「停止远控」',
  ticketExpired: '二维码已到期，请刷新后重新配对', remaining: '授权剩余', seconds: '秒', retry: '重试',
}
