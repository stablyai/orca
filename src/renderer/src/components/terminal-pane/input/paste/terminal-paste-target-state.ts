import { isEditableKeyboardTarget } from '../browser-pane/host-guest/browser-keyboard'

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
  // Permission/dictation handoffs can blur xterm to body or replace its textarea mid-paste.
  if (isInertDocumentFocus(activeElement)) {
    return true
  }
  if (activeElement === paneContainer) {
    return true
  }
  if (paneContainer.contains(activeElement)) {
    return isXtermHelperTextarea(activeElement)
  }
  // External dictation and overlays can leave focus on a non-input control; cancel only if another paste target took it.
  return !isOtherPasteTarget(activeElement)
}

function isOtherPasteTarget(element: Element | null): boolean {
  const tagName = element?.tagName?.toUpperCase()
  // Editable surfaces include other xterm helper textareas and Monaco's EditContext div.
  return isEditableKeyboardTarget(element) || tagName === 'IFRAME' || tagName === 'WEBVIEW'
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
