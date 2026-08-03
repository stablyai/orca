export type DesktopWindowChromeInput = {
  platform: NodeJS.Platform
  isWebClient: boolean
}

export function isPairedWebClientWindow(): boolean {
  return (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ === true
}

export function shouldRenderDesktopWindowChrome({
  platform,
  isWebClient
}: DesktopWindowChromeInput): boolean {
  return !isWebClient && (platform === 'win32' || platform === 'linux')
}

export function shouldRenderCustomWindowControls({
  platform,
  isWebClient
}: DesktopWindowChromeInput): boolean {
  // Why: Windows uses Electron's native Window Controls Overlay so the
  // maximize button exposes Windows 11 Snap Layouts. Frameless Linux still
  // needs the renderer-drawn min/max/close controls.
  return !isWebClient && platform === 'linux'
}

export function resolveWindowControlsWidth({
  platform,
  isWebClient
}: DesktopWindowChromeInput): string {
  if (!shouldRenderDesktopWindowChrome({ platform, isWebClient })) {
    return '0px'
  }
  // Why: webFrame zoom scales CSS pixels while Windows native caption buttons stay fixed-width.
  return platform === 'win32' ? 'calc(138px / var(--ui-zoom-factor, 1))' : '138px'
}
