import { quotePosixShellUnlessPlain } from '../../../../shared/shell-argument-quoting'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusPanePreservingOverlays } from '@/lib/pane-manager/pane-overlay-focus'
import { terminalHelperAwaitingImeRefocus } from './terminal-ime-input-context-refresh'

export function fitPanes(manager: PaneManager): void {
  manager.fitAllPanes()
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
  if (activePane) {
    focusPanePreservingOverlays(activePane)
  }
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

export function shouldPreserveEditableFocus(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false
  }
  if (element.classList.contains('xterm-helper-textarea') || element.closest('.xterm')) {
    return false
  }
  // Why: a field in a just-hidden pane keeps focus until Chromium drops it to body a task later.
  if (element.closest('[hidden], [inert]')) {
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

type PaneContainerOwner = {
  getPanes: () => readonly { container: Pick<HTMLElement, 'contains'> }[]
}

/**
 * True while keyboard focus sits in a terminal this manager does not own: another tab's pane
 * or the floating workspace. The user put it there, so layout maintenance must leave it alone.
 * A helper mid IME refresh counts as the owner even though the document reports body.
 */
export function anotherTerminalOwnsFocus(manager: PaneContainerOwner): boolean {
  if (typeof document === 'undefined') {
    return false
  }
  const active = document.activeElement
  const owner =
    active === null || active === document.body ? terminalHelperAwaitingImeRefocus() : active
  if (!(owner instanceof HTMLElement)) {
    return false
  }
  if (!owner.classList.contains('xterm-helper-textarea') && !owner.closest('.xterm')) {
    return false
  }
  return !manager.getPanes().some((pane) => pane.container.contains(owner))
}

// Why: escape rules are a property of the *target* shell receiving the path,
// not the client OS. A Windows client dropping onto a Linux SSH worktree must
// produce POSIX-quoted output; passing a userAgent string here coupled escape
// rules to the client and silently misquoted cross-platform SSH drops.
export function shellEscapePath(path: string, targetShell: 'posix' | 'windows'): string {
  if (targetShell === 'windows') {
    return /^[a-zA-Z0-9_./@:\\-]+$/.test(path) ? path : `"${path}"`
  }

  return quotePosixShellUnlessPlain(path)
}
