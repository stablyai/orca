import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager-types'

function fitAndRefreshPane(pane: ManagedPane): void {
  try {
    pane.fitAddon.fit()
    // Why: width animations from the left/right sidebars can leave xterm's
    // renderer showing only the pane background until some later paint or PTY
    // write arrives. Forcing a viewport refresh after fit keeps the existing
    // scrollback visible throughout the transition instead of flashing blank.
    if (pane.terminal.rows > 0) {
      pane.terminal.refresh(0, pane.terminal.rows - 1)
    }
  } catch {
    /* ignore */
  }
}

export function fitPanes(manager: PaneManager): void {
  for (const pane of manager.getPanes()) {
    fitAndRefreshPane(pane)
  }
}

export function focusActivePane(manager: PaneManager): void {
  const panes = manager.getPanes()
  const activePane = manager.getActivePane() ?? panes[0]
  activePane?.terminal.focus()
}

export function fitAndFocusPanes(manager: PaneManager): void {
  fitPanes(manager)
  focusActivePane(manager)
}

function isWindowsUserAgent(userAgent: string): boolean {
  return userAgent.includes('Windows')
}

export function shellEscapePath(
  path: string,
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): string {
  if (isWindowsUserAgent(userAgent)) {
    return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`
  }

  if (/^[a-zA-Z0-9_./@:-]+$/.test(path)) {
    return path
  }

  return `'${path.replace(/'/g, "'\\''")}'`
}
