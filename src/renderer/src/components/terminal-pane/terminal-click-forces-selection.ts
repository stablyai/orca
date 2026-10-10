// Why: mirrors xterm's SelectionService.shouldForceSelection — a shifted click
// (Option-click on Mac, via macOptionClickForcesSelection) is never forwarded
// as a mouse report, so the TUI cannot paste and Orca must own it instead.
export function terminalForcesSelectionForClick(
  event: Pick<MouseEvent, 'altKey' | 'shiftKey'>
): boolean {
  return navigator.userAgent.includes('Mac') ? event.altKey : event.shiftKey
}
