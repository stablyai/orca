export type DesktopWindowChromeInput = {
  platform: NodeJS.Platform
  isWebClient: boolean
}

export function isPairedWebClientWindow(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

export function isLocalWindowsDesktopClient(): boolean {
  return (
    !isPairedWebClientWindow() &&
    typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Windows')
  )
}

export function shouldRenderDesktopWindowChrome({
  platform,
  isWebClient
}: DesktopWindowChromeInput): boolean {
  return !isWebClient && (platform === 'win32' || platform === 'linux')
}

/** Desktop macOS keeps the left inset for native traffic lights. A paired browser has none. */
export function macTrafficLightsWidth(input: {
  isMac: boolean
  isWebClient: boolean
}): '80px' | '0px' {
  return input.isMac && !input.isWebClient ? '80px' : '0px'
}

/** The pad element is hidden in fullscreen; the width token above stays, matching desktop today. */
export function shouldShowMacTrafficLightPad(input: {
  isMac: boolean
  isWebClient: boolean
  isFullScreen: boolean
}): boolean {
  return input.isMac && !input.isWebClient && !input.isFullScreen
}

/**
 * One read of the paired-web flag feeds both the width token and the pad.
 * Call sites that pass `isWebClient` themselves can drift apart.
 */
export function macTrafficLightChromeForWindow(input: { isMac: boolean; isFullScreen: boolean }): {
  width: '80px' | '0px'
  showPad: boolean
} {
  const isWebClient = isPairedWebClientWindow()
  return {
    width: macTrafficLightsWidth({ isMac: input.isMac, isWebClient }),
    showPad: shouldShowMacTrafficLightPad({
      isMac: input.isMac,
      isWebClient,
      isFullScreen: input.isFullScreen
    })
  }
}
