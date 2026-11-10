import { isEditableKeyboardTarget } from '@/components/browser-pane/host-guest/browser-keyboard'

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
  holdsInputUntilConnect?: () => boolean
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
  const mounted = Boolean(
    manager?.getPanes().some((pane) => pane.id === paneId && pane.leafId === leafId) &&
    transport &&
    paneTransports.get(paneId) === transport
  )
  if (!mounted || !transport) {
    return false
  }
  const livePtyId = transport.getPtyId()
  if (transport.isConnected()) {
    if (livePtyId === ptyId) {
      return true
    }
    // Paste began before the PTY existed; remaining chunks may still join the pre-connect queue.
    return ptyId === null && transport.holdsInputUntilConnect?.() === true
  }
  // A pane that already had a PTY stays stale while disconnected. Only unbound held input can accept paste.
  return ptyId === null && livePtyId === null && transport.holdsInputUntilConnect?.() === true
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
  // xterm can replace its helper textarea mid-paste.
  if (paneContainer.contains(activeElement) && isXtermHelperTextarea(activeElement)) {
    return true
  }
  // Blur to body, overlays and external dictation move focus mid-paste; cancel only if another typing surface took it.
  return !isOtherPasteTarget(activeElement)
}

function isOtherPasteTarget(element: Element | null): boolean {
  const tagName = element?.tagName?.toUpperCase()
  return isEditableKeyboardTarget(element) || tagName === 'IFRAME' || tagName === 'WEBVIEW'
}

function isXtermHelperTextarea(element: Element | null): boolean {
  return element?.classList?.contains('xterm-helper-textarea') === true
}
