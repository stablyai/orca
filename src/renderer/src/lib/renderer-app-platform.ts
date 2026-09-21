// Why: hot render paths call this per render; the preload answer never changes, so
// cache it. The user-agent fallback stays uncached because window.api can still be
// installing (the web client injects its own platform API after boot).
let cachedAppPlatform: NodeJS.Platform | undefined

export function getRendererAppPlatform(): NodeJS.Platform {
  if (cachedAppPlatform) {
    return cachedAppPlatform
  }
  const preloadPlatform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (preloadPlatform) {
    cachedAppPlatform = preloadPlatform
    return preloadPlatform
  }
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (userAgent.includes('Windows')) {
    return 'win32'
  }
  if (userAgent.includes('Mac')) {
    return 'darwin'
  }
  if (userAgent) {
    return 'linux'
  }
  return 'win32'
}

/** Tests swap the window.api platform stub between cases; the real value never changes. */
export function resetRendererAppPlatformCacheForTests(): void {
  cachedAppPlatform = undefined
}
