import { translate } from '@/i18n/i18n'
import { createLiveSurfaceTabRightOf } from './ensure-simulator-tab'

type DesktopAppHostPlatform = { platform?: string; displayServer?: string | null }

function hostPlatform(): DesktopAppHostPlatform | null {
  try {
    return window.api?.platform?.get?.() ?? null
  } catch {
    return null
  }
}

/** True when this client runs on a Mac (drives the shortcut and permission wording). */
export function isMacDesktopAppHost(): boolean {
  const platform = hostPlatform()?.platform
  if (platform) {
    return platform === 'darwin'
  }
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

/**
 * Desktop app tabs show a local window of another app, so only the Electron client offers them.
 * Why X11 only on Linux: Wayland gives apps no way to list or drive other apps' windows, so the
 * runtime would only ever answer unsupported_capability there.
 */
export function canOpenDesktopAppTab(): boolean {
  if (typeof window === 'undefined' || !window.api?.desktopApp) {
    return false
  }
  const host = hostPlatform()
  if (!host?.platform) {
    return isMacDesktopAppHost()
  }
  if (host.platform === 'linux') {
    return host.displayServer === 'x11'
  }
  return host.platform === 'darwin' || host.platform === 'win32'
}

/** A new Desktop App tab beside the source group (to its right, reusing an existing right split). */
export function openDesktopAppTab(worktreeId: string, sourceGroupId: string): string | null {
  return createLiveSurfaceTabRightOf(
    worktreeId,
    sourceGroupId,
    'desktop-app',
    translate('auto.lib.open.desktop.app.tab.42cef4eb31', 'Desktop App')
  )
}
