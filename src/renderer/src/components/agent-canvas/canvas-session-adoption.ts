import type { CanvasDocument } from './agent-canvas-document'

export function adoptCanvasAgentSession(document: CanvasDocument, nodeId: string): CanvasDocument {
  if (!document.nodes.some((node) => node.id === nodeId && node.kind === 'agent')) {
    return document
  }
  // A user-confirmed new binding adopts the host's current identity; ordinary sync keeps its fence.
  const replacementId = crypto.randomUUID()
  return {
    ...document,
    nodes: document.nodes.map((node) =>
      node.id === nodeId ? { ...node, id: replacementId } : node
    ),
    edges: document.edges.map((edge) => ({
      ...edge,
      source: edge.source === nodeId ? replacementId : edge.source,
      target: edge.target === nodeId ? replacementId : edge.target
    }))
  }
}
