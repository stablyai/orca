// The first time an SSH host drives a desktop browser tab, the desktop says so and offers Stop / Don't allow.

export const DESKTOP_BROWSER_BRIDGE_HOST_NOTICE_CHANNEL = 'browser:remoteHostControlNotice'
export const DESKTOP_BROWSER_BRIDGE_HOST_STOP_CHANNEL = 'browser:remoteHostControlStop'
export const DESKTOP_BROWSER_BRIDGE_HOST_DISALLOW_CHANNEL = 'browser:remoteHostControlDisallow'

export type DesktopBrowserBridgeHostNotice = {
  targetId: string
  hostLabel: string
  /** False for hosts Orca created itself, whose settings are not user-editable. */
  canDisallow: boolean
}
