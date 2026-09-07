import {
  isEventTargetInsideFloatingWorkspacePanel,
  isFloatingWorkspaceTerminalInputTarget
} from '@/lib/floating-workspace-terminal-actions'

let lastReportedFloatingFocus: { panelFocused: boolean; terminalFocused: boolean } | null = null
let lastReportedFloatingFocusFn: unknown = null

export function reportFloatingFocus(next: EventTarget | null, release = false): void {
  const setFloatingFocus = window.api.ui.setFloatingFocus
  // Dev reloads can pair a new renderer with an older preload.
  if (typeof setFloatingFocus !== 'function') {
    return
  }
  if (setFloatingFocus !== lastReportedFloatingFocusFn) {
    lastReportedFloatingFocus = null
    lastReportedFloatingFocusFn = setFloatingFocus
  }
  const terminalFocused = !release && isFloatingWorkspaceTerminalInputTarget(next)
  const panelFocused =
    !release && (terminalFocused || isEventTargetInsideFloatingWorkspacePanel(next))
  if (
    lastReportedFloatingFocus !== null &&
    lastReportedFloatingFocus.panelFocused === panelFocused &&
    lastReportedFloatingFocus.terminalFocused === terminalFocused
  ) {
    return
  }
  lastReportedFloatingFocus = { panelFocused, terminalFocused }
  setFloatingFocus({ panelFocused, terminalFocused })
}

export function clearReportedFloatingFocusCache(): void {
  lastReportedFloatingFocus = null
  lastReportedFloatingFocusFn = null
}
