/** The browser entry retains the package's canvas overloads without its Node file writers. */
declare module 'qrcode/lib/browser.js' {
  import type * as QRCode from 'qrcode'
  const browser: Pick<typeof QRCode, 'toDataURL'>
  export default browser
}
