import { MarkerType } from '@xyflow/react'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import type { CanvasDocument } from './agent-canvas-document'
import type { CanvasFlowEdge } from './AgentCanvasEdge'

export function buildCanvasFlowEdges(
  document: CanvasDocument,
  cards: Map<string, DashboardCard>,
  selectedId: string | null,
  readOnly: boolean,
  onOpen: (id: string | null) => void,
  onRemove: (id: string) => void,
  scope?: string
): CanvasFlowEdge[] {
  const pairs = new Set(document.edges.map((edge) => JSON.stringify([edge.source, edge.target])))
  return document.edges.flatMap((edge) => {
    const source = document.nodes.find((node) => node.id === edge.source)
    const target = document.nodes.find((node) => node.id === edge.target)
    if (!source || !target) {
      return []
    }
    return [
      {
        ...edge,
        type: 'context',
        selected: edge.id === selectedId,
        markerStart:
          source.kind === 'agent' && target.kind === 'agent'
            ? { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)' }
            : undefined,
        markerEnd:
          source.kind === 'note'
            ? undefined
            : { type: MarkerType.ArrowClosed, color: 'var(--muted-foreground)' },
        data: {
          scope,
          paused: document.collaborationPaused,
          browserControl: edge.kind === 'browser-control',
          reciprocal: pairs.has(JSON.stringify([edge.target, edge.source])),
          source,
          target,
          sourceCard: cards.get(source.agentKey ?? source.agentTabId ?? ''),
          targetCard: cards.get(target.agentKey ?? target.agentTabId ?? ''),
          readOnly,
          onOpen,
          onRemove
        }
      }
    ]
  })
}
