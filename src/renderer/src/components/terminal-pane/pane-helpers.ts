import type { PaneManager } from '@/lib/pane-manager/pane-manager'

export function fitPanes(manager: PaneManager): void {
  manager.fitAllPanes()
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
  // Why: tab rename focuses the input on the next frame. A queued terminal
  // layout focus can land in between mount and focus, blurring rename closed.
  if (typeof document !== 'undefined' && document.querySelector('[data-tab-rename-input="true"]')) {
    return
  }
  const activeElement = typeof document === 'undefined' ? null : document.activeElement
  if (shouldPreserveEditableFocus(activeElement)) {
    return
  }
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

export function isLinuxUserAgent(
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return !isMacUserAgent(userAgent) && !isWindowsUserAgent(userAgent) && userAgent.includes('Linux')
}

function shouldPreserveEditableFocus(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  if (element.classList.contains('xterm-helper-textarea') || element.closest('.xterm')) {
    return false
  }
  // Why: deferred fit/focus work can run after inline rename or settings
  // fields take focus. Layout maintenance must not blur user edits closed.
  return (
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  )
}

// Why: escape rules are a property of the *target* shell receiving the path,
// not the client OS. A Windows client dropping onto a Linux SSH worktree must
// produce POSIX-quoted output; passing a userAgent string here coupled escape
// rules to the client and silently misquoted cross-platform SSH drops.
export function shellEscapePath(path: string, targetShell: 'posix' | 'windows'): string {
  if (targetShell === 'windows') {
    return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`
  }

  if (/^[a-zA-Z0-9_./@:-]+$/.test(path)) {
    return path
  }

  return `'${path.replace(/'/g, "'\\''")}'`
}
