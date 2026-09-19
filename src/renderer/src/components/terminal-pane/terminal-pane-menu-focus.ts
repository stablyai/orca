import {
  scheduleNextFrame,
  type TerminalImeInputContextRefocusScheduler
} from './terminal-ime-input-context-refresh'

export type TerminalFocusTargetElement = {
  contains?: (node: Node | null) => boolean
}

export type TerminalFocusTargetTerminal = {
  focus: () => void
  element?: TerminalFocusTargetElement | null
  textarea?: Element | null
}

export type TerminalFocusTargetDocument = {
  body?: Element | null
  activeElement?: Element | null
}

export type TerminalFocusTargetContainer = {
  isConnected: boolean
  ownerDocument?: TerminalFocusTargetDocument | null
}

export type TerminalFocusTarget = {
  container: TerminalFocusTargetContainer
  terminal: TerminalFocusTargetTerminal
}

export type ReclaimTerminalPaneFocusOptions = {
  scheduleRefocus?: TerminalImeInputContextRefocusScheduler
}

type ClassListCarrier = {
  classList: {
    contains: (token: string) => boolean
  }
}

function hasClassList(value: unknown): value is ClassListCarrier {
  return (
    typeof value === 'object' &&
    value !== null &&
    'classList' in value &&
    typeof value.classList === 'object' &&
    value.classList !== null &&
    'contains' in value.classList &&
    typeof value.classList.contains === 'function'
  )
}

function isNode(value: unknown): value is Node {
  return typeof Node !== 'undefined' && value instanceof Node
}

function isNeutralOrTerminalOwnedFocus(
  active: unknown,
  doc: TerminalFocusTargetDocument,
  pane: TerminalFocusTarget
): boolean {
  if (active === null || active === undefined || active === doc.body) {
    return true
  }
  if (active === pane.container) {
    return true
  }
  if (pane.terminal.textarea && active === pane.terminal.textarea) {
    return true
  }
  if (isNode(active) && pane.terminal.element?.contains?.(active)) {
    return true
  }
  if (hasClassList(active) && active.classList.contains('xterm-helper-textarea')) {
    return true
  }
  return false
}

/**
 * Reclaims focus for a terminal pane after a context menu close or right-click gesture,
 * ensuring focus is never stolen from an active control (either in-pane or external)
 * that the user legitimately clicked.
 */
export function reclaimTerminalPaneFocus(
  pane: TerminalFocusTarget | null | undefined,
  options?: ReclaimTerminalPaneFocusOptions
): void {
  if (!pane) {
    return
  }
  const schedule = options?.scheduleRefocus ?? scheduleNextFrame
  schedule(() => {
    const container = pane.container
    if (!container.isConnected) {
      return
    }
    const doc: TerminalFocusTargetDocument =
      container.ownerDocument ?? (typeof document !== 'undefined' ? document : {})
    const active = doc.activeElement ?? null
    // Guard: only reclaim when activeElement is neutral (body / null) or owned by the terminal.
    // In-pane controls (e.g. TerminalSearch input portaled into container) and outside controls
    // (e.g. rename input, another pane, dialog button) are preserved and never stolen.
    if (isNeutralOrTerminalOwnedFocus(active, doc, pane)) {
      pane.terminal.focus()
    }
  })
}
