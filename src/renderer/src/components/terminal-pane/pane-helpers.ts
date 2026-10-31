import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { focusPanePreservingOverlays } from '@/lib/pane-manager/pane-overlay-focus'

export function fitPanes(manager: PaneManager): void {
  manager.fitAllPanes()
}

export function focusActivePane(manager: PaneManager): void {
  // Tab rename focuses next frame; queued layout focus must not blur it closed first.
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

/** Coalesce same-turn resizes without dropping a focus request a later fit-only call would cancel. */
export function createQueuedPaneResize(run: (focusActive: boolean) => void): {
  queue: (focusActive: boolean) => void
  cancel: () => void
} {
  let handle: number | null = null
  let focusActive = false
  return {
    queue(next) {
      focusActive = focusActive || next
      if (handle !== null) {
        cancelAnimationFrame(handle)
      }
      handle = requestAnimationFrame(() => {
        handle = null
        const focus = focusActive
        focusActive = false
        run(focus)
      })
    },
    cancel() {
      if (handle !== null) {
        cancelAnimationFrame(handle)
        handle = null
      }
      focusActive = false
    }
  }
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
  // Deferred layout maintenance must not steal focus from rename or settings edits.
  return (
    element.isContentEditable ||
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT'
  )
}

export { shellEscapePath } from '../../../../shared/shell-path-quoting'
