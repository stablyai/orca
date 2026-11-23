import type { ConversationKnowledgeMapOverviewNode } from './conversation-knowledge-map-layout'

export function conversationKnowledgeMapNodeSize(evidenceCount: number): number {
  return Math.min(112, 72 + evidenceCount * 8)
}

export function fitConversationKnowledgeMap(
  nodes: readonly ConversationKnowledgeMapOverviewNode[],
  viewport: { width: number; height: number }
): { scale: number; x: number; y: number } {
  if (!nodes.length || viewport.width <= 0 || viewport.height <= 0) {
    return { scale: 1, x: 0, y: 0 }
  }
  const bounds = nodes.reduce(
    (result, node) => {
      const radius = conversationKnowledgeMapNodeSize(node.entry.evidenceCount) / 2
      return {
        left: Math.min(result.left, node.x - radius),
        right: Math.max(result.right, node.x + radius),
        top: Math.min(result.top, node.y - radius),
        bottom: Math.max(result.bottom, node.y + radius)
      }
    },
    { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
  )
  const scale = Math.min(
    1.2,
    Math.max(1, viewport.width - 64) / (bounds.right - bounds.left),
    Math.max(1, viewport.height - 96) / (bounds.bottom - bounds.top)
  )
  return {
    scale,
    x: viewport.width / 2 - ((bounds.left + bounds.right) / 2) * scale,
    y: viewport.height / 2 - ((bounds.top + bounds.bottom) / 2) * scale
  }
}
