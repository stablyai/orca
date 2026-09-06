import { z } from 'zod'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'

const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite() })
const nodeSchema = z.object({
  id: z.string(),
  kind: z.enum(['agent', 'note', 'browser']),
  position: positionSchema,
  width: z.number().min(240).max(1600),
  height: z.number().min(160).max(1200),
  title: z.string().max(1024),
  content: z.string().max(100_000),
  agentKey: z.string().optional(),
  agentTabId: z.string().optional(),
  browserTabId: z.string().optional()
})
const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  kind: z.literal('browser-control').optional()
})
export const canvasDocumentSchema = z
  .object({
    version: z.literal(1),
    collaborationPaused: z.boolean().optional(),
    nodes: z.array(nodeSchema).max(500),
    edges: z.array(edgeSchema).max(2000),
    viewport: z.object({
      x: z.number().finite(),
      y: z.number().finite(),
      zoom: z.number().min(0.2).max(2)
    })
  })
  .superRefine((document, context) => {
    const ids = new Set(document.nodes.map((node) => node.id))
    if (
      ids.size !== document.nodes.length ||
      new Set(document.edges.map((edge) => edge.id)).size !== document.edges.length
    ) {
      context.addIssue({ code: 'custom', message: 'Duplicate canvas identity' })
    }
    for (const edge of document.edges) {
      if (!canConnectCanvasNodes(document, edge.source, edge.target, edge.id)) {
        context.addIssue({ code: 'custom', message: 'Invalid canvas connection' })
      }
    }
  })

export type CanvasNode = z.infer<typeof nodeSchema>
export type CanvasEdge = z.infer<typeof edgeSchema>
export type CanvasDocument = {
  version: 1
  collaborationPaused?: boolean
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: { x: number; y: number; zoom: number }
}

export function emptyCanvasDocument(): CanvasDocument {
  return { version: 1, nodes: [], edges: [], viewport: { x: 40, y: 40, zoom: 1 } }
}

export function canvasAgentKey(card: DashboardCard): string {
  return JSON.stringify([card.executionHostId ?? null, card.repoId, card.worktreeId, card.paneKey])
}

export function canvasProjectKey(card: Pick<DashboardCard, 'repoId' | 'executionHostId'>): string {
  return JSON.stringify([card.executionHostId ?? null, card.repoId])
}

export function findCanvasNodePosition(
  nodes: CanvasNode[],
  start: CanvasNode['position'],
  size: Pick<CanvasNode, 'width' | 'height'>
): CanvasNode['position'] {
  const gap = 64
  const position = { ...start }
  for (let attempt = 0; attempt < nodes.length; attempt++) {
    const overlap = nodes.find(
      (node) =>
        position.x < node.position.x + node.width + gap &&
        position.x + size.width + gap > node.position.x &&
        position.y < node.position.y + node.height + gap &&
        position.y + size.height + gap > node.position.y
    )
    if (!overlap) {
      break
    }
    position.y = overlap.position.y + overlap.height + gap
  }
  return position
}

export function canConnectCanvasNodes(
  document: Pick<CanvasDocument, 'nodes' | 'edges'>,
  source: string,
  target: string,
  exceptEdgeId?: string
): boolean {
  const from = document.nodes.find((node) => node.id === source)
  const to = document.nodes.find((node) => node.id === target)
  return Boolean(
    from &&
    to?.kind === 'agent' &&
    source !== target &&
    !document.edges.some(
      (edge) => edge.id !== exceptEdgeId && edge.source === source && edge.target === target
    )
  )
}

export function removeCanvasNodes(
  document: CanvasDocument,
  ids: ReadonlySet<string>
): CanvasDocument {
  return {
    ...document,
    nodes: document.nodes.filter((node) => !ids.has(node.id)),
    edges: document.edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target))
  }
}

export function canvasContext(node: CanvasNode, card?: DashboardCard): string {
  if (node.kind === 'agent') {
    return card?.lastAgentMessage ?? ''
  }
  return node.content
}
