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
  // Why: clipboard reads are async, so focus may leave the terminal before
  // execution. In that case the stale terminal must not receive the payload.
  return (
    activeElement === activeElementAtDispatch && paneContainer.contains(activeElementAtDispatch)
  )
}
