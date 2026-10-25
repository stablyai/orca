/** What an explicit terminal close removes. A pane close never stands in for its tab. */
export type TerminalSurfaceCloseTarget =
  | { kind: 'tab'; tabId: string }
  | { kind: 'pane'; tabId: string; leafId: string }

export type TerminalPaneCloseTarget = Extract<TerminalSurfaceCloseTarget, { kind: 'pane' }>

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Validates a close target that crossed a process boundary; anything malformed is rejected. */
export function parseTerminalSurfaceCloseTarget(value: unknown): TerminalSurfaceCloseTarget | null {
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('tabId' in value)) {
    return null
  }
  const { kind, tabId } = value
  if (!isNonEmptyString(tabId)) {
    return null
  }
  if (kind === 'tab') {
    return { kind, tabId }
  }
  if (kind !== 'pane' || !('leafId' in value) || !isNonEmptyString(value.leafId)) {
    return null
  }
  return { kind, tabId, leafId: value.leafId }
}
