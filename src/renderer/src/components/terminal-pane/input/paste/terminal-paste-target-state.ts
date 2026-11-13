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
  isHoldingInput?: () => boolean
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
  if (
    !manager?.getPanes().some((pane) => pane.id === paneId && pane.leafId === leafId) ||
    !transport ||
    paneTransports.get(paneId) !== transport
  ) {
    return false
  }
  // A paste made before the first bind (ptyId null) may follow this transport onto the PTY it binds.
  const livePtyId = transport.getPtyId()
  return (
    (livePtyId === ptyId || ptyId === null) &&
    (transport.isConnected() || transport.isHoldingInput?.() === true)
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
  // Why: a removed dispatch element (xterm re-opens its textarea while a pane starts) is app churn; judge the current focus instead.
  if (activeElementAtDispatch.isConnected && !paneContainer.contains(activeElementAtDispatch)) {
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
