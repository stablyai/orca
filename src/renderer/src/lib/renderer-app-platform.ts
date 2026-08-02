export function getRendererAppPlatform(): NodeJS.Platform {
  const preloadPlatform =
    typeof window === 'undefined' ? undefined : window.api?.platform?.get?.()?.platform
  if (preloadPlatform) {
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
