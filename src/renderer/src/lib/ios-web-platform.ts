/**
 * True when the renderer runs inside iOS/iPadOS WebKit — the web client opened
 * in a browser on an iPhone or iPad.
 *
 * Every iOS and iPadOS user agent contains `Mac`: iPad desktop mode (the
 * default since iPadOS 13) reports `Macintosh; Intel Mac OS X`, and mobile mode
 * reports `like Mac OS X`. Desktop mode omits `iPad`, so the touch-point count
 * is the only signal separating an iPad from a Mac. Both browsers on the
 * platform are WebKit — iOS bars third-party engines — so this covers Safari,
 * Chrome and the rest alike.
 */
export function isIosWebPlatform(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return true
  }
  return userAgent.includes('Mac') && maxTouchPoints > 1
}

/**
 * Returns true if the current environment is an iOS or iPadOS web client browser.
 * Safe to invoke in SSR or non-DOM environments where navigator is undefined.
 */
export function isCurrentPlatformIosWeb(): boolean {
  if (typeof navigator === 'undefined') {
    return false
  }
  return isIosWebPlatform(navigator.userAgent, navigator.maxTouchPoints)
}
