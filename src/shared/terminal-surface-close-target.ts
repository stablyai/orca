/** What an explicit terminal close removes. A pane close never stands in for its tab. */
export type TerminalSurfaceCloseTarget =
  | { kind: 'tab'; tabId: string }
  | { kind: 'pane'; tabId: string; leafId: string }

export type TerminalPaneCloseTarget = Extract<TerminalSurfaceCloseTarget, { kind: 'pane' }>

function readNonEmptyString(value: object, key: string): string | null {
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' && field.length > 0 ? field : null
}

/** Validates a close target that crossed a process boundary; anything malformed is rejected. */
export function parseTerminalSurfaceCloseTarget(value: unknown): TerminalSurfaceCloseTarget | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const kind: unknown = Reflect.get(value, 'kind')
  const tabId = readNonEmptyString(value, 'tabId')
  if (!tabId) {
    return null
  }
  if (kind === 'tab') {
    return { kind, tabId }
  }
  const leafId = readNonEmptyString(value, 'leafId')
  return kind === 'pane' && leafId ? { kind, tabId, leafId } : null
}
