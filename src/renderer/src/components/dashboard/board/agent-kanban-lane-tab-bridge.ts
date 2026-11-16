export type AgentKanbanCardEdge = 'first' | 'last'

const CARD_CONTROL_SELECTOR =
  'button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])'

function edgeControl(row: Element, edge: AgentKanbanCardEdge): HTMLElement | undefined {
  const controls = Array.from(row.querySelectorAll<HTMLElement>(CARD_CONTROL_SELECTOR))
  return controls.at(edge === 'first' ? 0 : -1)
}

/**
 * Resolve the logical neighbour a Tab leaving this card must reach when native order would skip it.
 * Null means native Tab is already correct: still inside the card, a true lane edge, or the neighbour is the adjacent mounted row.
 */
export function resolveAgentKanbanTabBridge(
  row: HTMLElement,
  target: EventTarget,
  backward: boolean,
  index: number,
  count: number
): { index: number; edge: AgentKanbanCardEdge } | null {
  if (target !== edgeControl(row, backward ? 'first' : 'last')) {
    return null
  }
  const neighbourIndex = backward ? index - 1 : index + 1
  if (neighbourIndex < 0 || neighbourIndex >= count) {
    return null
  }
  const sibling = backward ? row.previousElementSibling : row.nextElementSibling
  if (sibling?.getAttribute('data-index') === String(neighbourIndex)) {
    return null
  }
  return { index: neighbourIndex, edge: backward ? 'last' : 'first' }
}

export function focusAgentKanbanCardEdge(row: Element, edge: AgentKanbanCardEdge): void {
  // The caller already revealed the row; avoid a second native scroll to an estimated offset.
  edgeControl(row, edge)?.focus({ preventScroll: true })
}
