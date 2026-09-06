import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { canvasAgentKey, type CanvasDocument } from './agent-canvas-document'

export function indexCanvasAgents(cards: DashboardCard[]): Map<string, DashboardCard> {
  const index = new Map(cards.map((card) => [canvasAgentKey(card), card]))
  const counts = new Map<string, number>()
  for (const card of cards) {
    counts.set(card.tabId, (counts.get(card.tabId) ?? 0) + 1)
  }
  for (const card of cards) {
    if (counts.get(card.tabId) === 1) {
      index.set(card.tabId, card)
    }
  }
  return index
}

export function bindCanvasAgentNodes(
  document: CanvasDocument,
  index: Map<string, DashboardCard>
): CanvasDocument {
  let changed = false
  const nodes = document.nodes.map((node) => {
    const card = !node.agentKey && node.agentTabId ? index.get(node.agentTabId) : undefined
    if (!card) {
      return node
    }
    changed = true
    return { ...node, agentKey: canvasAgentKey(card) }
  })
  return changed ? { ...document, nodes } : document
}
