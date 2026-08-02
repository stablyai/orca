type TerminalPastePaneIdentity = {
  id: number
  leafId: string
}

type TerminalPastePaneManager = {
  getPanes: () => readonly TerminalPastePaneIdentity[]
}

type TerminalPasteTransport = {
  getPtyId: () => string | null
  isConnected: () => boolean
}

export type TerminalPasteTargetState = {
  manager: TerminalPastePaneManager | null
  paneTransports: ReadonlyMap<number, TerminalPasteTransport>
  paneId: number
  leafId: string
  transport: TerminalPasteTransport | undefined
  ptyId: string | null
}

export function isTerminalPanePasteTargetCurrent({
  manager,
  paneTransports,
  paneId,
  leafId,
  transport,
  ptyId
}: TerminalPasteTargetState): boolean {
  return Boolean(
    manager?.getPanes().some((pane) => pane.id === paneId && pane.leafId === leafId) &&
    transport &&
    paneTransports.get(paneId) === transport &&
    transport.isConnected() &&
    transport.getPtyId() === ptyId
  )
}

export type TerminalPanePasteFocusState = {
  requireSameFocusedElement: boolean
  activeElementAtDispatch: Element | null
  paneContainer: Element
  activeElement?: Element | null
}

export function isTerminalPanePasteFocusCurrent({
  requireSameFocusedElement,
  activeElementAtDispatch,
  paneContainer,
  activeElement = typeof document === 'undefined' ? null : document.activeElement
}: TerminalPanePasteFocusState): boolean {
  if (!requireSameFocusedElement || activeElementAtDispatch === null) {
    return true
  }
  if (!paneContainer.contains(activeElementAtDispatch)) {
    return false
  }
  if (activeElement === activeElementAtDispatch) {
    return true
  }
  // Why: macOS dictation and clipboard permission handoffs can transiently
  // blur xterm to body, and xterm may replace its helper textarea mid-paste.
  if (isInertDocumentFocus(activeElement)) {
    return true
  }
  if (activeElement === paneContainer) {
    return true
  }
  return paneContainer.contains(activeElement) && isXtermHelperTextarea(activeElement)
}

function isInertDocumentFocus(element: Element | null): boolean {
  if (!element) {
    return true
  }
  const tagName = element.tagName?.toUpperCase()
  return tagName === 'BODY' || tagName === 'HTML'
}

function isXtermHelperTextarea(element: Element | null): boolean {
  return element?.classList?.contains('xterm-helper-textarea') === true
}
