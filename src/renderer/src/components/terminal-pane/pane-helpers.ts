import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { ScrollState } from '@/lib/pane-manager/pane-manager-types'

export function fitPanes(manager: PaneManager, preCapturedStates?: Map<number, ScrollState>): void {
  manager.fitAllPanes(preCapturedStates)
}

/**
 * Returns true if any pane's proposed dimensions differ from its current
 * terminal cols/rows, meaning a fit() call would actually change layout.
 * Used by the epoch-based deduplication in use-terminal-pane-global-effects
 * to allow legitimate resize fits while suppressing redundant ones.
 */
export function hasDimensionsChanged(manager: PaneManager): boolean {
  for (const pane of manager.getPanes()) {
    try {
      const dims = pane.fitAddon.proposeDimensions()
      if (!dims) {
        return true // can't determine — assume changed
      }
      if (dims.cols !== pane.terminal.cols || dims.rows !== pane.terminal.rows) {
        return true
      }
    } catch {
      return true
    }
  }
  return false
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

export function isWindowsUserAgent(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return userAgent.includes('Windows')
}

export function isMacUserAgent(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return userAgent.includes('Mac')
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
