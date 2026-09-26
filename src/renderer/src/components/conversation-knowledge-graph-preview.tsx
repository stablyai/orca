import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import type {
  ConversationKnowledgeGraph,
  ConversationKnowledgeGraphRelation,
  ConversationKnowledgeGraphNode
} from '../../../shared/conversation-knowledge-graph'
import type { ConversationKnowledgeItem } from '../../../shared/conversation-knowledge-items'

type PositionedNode = ConversationKnowledgeGraphNode & { height: number; x: number; y: number }
type FocusedNode = { id: string; viewMode: 'all' | 'project'; projectId: string | null }

const MAX_NODE_WIDTH = 176
const MIN_NODE_WIDTH = 128
const NODE_MIN_HEIGHT = 64
const NODE_DETAIL_LINE_HEIGHT = 16
const NODE_VERTICAL_GAP = 18
const GRAPH_SIDE_PADDING = 18
const GRAPH_MIN_WIDTH = 580

export function ConversationKnowledgeGraphPreview({
  graph,
  selectedItemId,
  onSelectItem,
  onSelectNode,
  viewMode = 'all',
  projectId = null,
  emptyMessage
}: {
  graph: ConversationKnowledgeGraph
  selectedItemId?: string | null
  onSelectItem: (item: ConversationKnowledgeItem) => void
  onSelectNode?: (node: ConversationKnowledgeGraphNode) => void
  viewMode?: 'all' | 'project'
  projectId?: string | null
  emptyMessage?: string
}): React.JSX.Element {
  useTranslation()
  const [focusedNode, setFocusedNode] = useState<FocusedNode | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [viewportWidth, setViewportWidth] = useState(GRAPH_MIN_WIDTH)
  const focusedNodeId =
    focusedNode?.viewMode === viewMode && focusedNode.projectId === projectId
      ? focusedNode.id
      : null
  const visibleGraph = useMemo(
    () => focusConversationKnowledgeGraph(graph, focusedNodeId),
    [graph, focusedNodeId]
  )
  const canvasWidth = Math.max(GRAPH_MIN_WIDTH, viewportWidth)
  const nodeWidth = useMemo(
    () => conversationKnowledgeGraphNodeWidth(visibleGraph, canvasWidth),
    [canvasWidth, visibleGraph]
  )
  const positions = useMemo(
    () => positionConversationKnowledgeGraphNodes(visibleGraph, canvasWidth, nodeWidth),
    [canvasWidth, nodeWidth, visibleGraph]
  )
  const positionById = useMemo(() => new Map(positions.map((node) => [node.id, node])), [positions])
  const height = Math.max(240, ...positions.map((node) => node.y + node.height + NODE_VERTICAL_GAP))

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') {
      return
    }
    const measure = (): void => {
      const nextWidth = viewport.clientWidth
      if (nextWidth > 0) {
        setViewportWidth((current) => (current === nextWidth ? current : nextWidth))
      }
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [positions.length])

  if (!positions.length) {
    return (
      <div className="flex min-h-52 items-center justify-center px-6 text-center text-sm text-muted-foreground">
        {emptyMessage ??
          translate('conversationKnowledge.empty.generated', 'No generated knowledge yet.')}
      </div>
    )
  }

  return (
    <div
      ref={viewportRef}
      tabIndex={0}
      aria-label={translate('conversationKnowledge.graph', 'Conversation Knowledge Graph')}
      className="scrollbar-sleek h-full min-h-0 overflow-auto overscroll-contain rounded-lg border border-border/60 bg-muted/15 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <div className="relative" style={{ height, width: canvasWidth }}>
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          <defs>
            <marker
              id="conversation-knowledge-arrow"
              markerHeight="6"
              markerWidth="6"
              orient="auto-start-reverse"
              refX="5"
              refY="3"
              viewBox="0 0 6 6"
            >
              <path d="M 0 0 L 6 3 L 0 6 z" fill="var(--border)" />
            </marker>
          </defs>
          {visibleGraph.edges.map((edge) => {
            const source = positionById.get(edge.source)
            const target = positionById.get(edge.target)
            if (!source || !target) {
              return null
            }
            const leftToRight = source.x <= target.x
            const startX = leftToRight ? source.x + nodeWidth : source.x
            const startY = source.y + source.height / 2
            const endX = leftToRight ? target.x : target.x + nodeWidth
            const endY = target.y + target.height / 2
            const bend = Math.max(32, Math.abs(endX - startX) * 0.42)
            const direction = leftToRight ? 1 : -1
            return (
              <g key={`${edge.source}:${edge.relation}:${edge.target}`}>
                <path
                  d={`M ${startX} ${startY} C ${startX + bend * direction} ${startY}, ${endX - bend * direction} ${endY}, ${endX} ${endY}`}
                  fill="none"
                  markerEnd="url(#conversation-knowledge-arrow)"
                  opacity="0.6"
                  stroke="var(--border)"
                  strokeLinecap="round"
                  strokeWidth="1.5"
                />
                <text
                  x={(startX + endX) / 2}
                  y={(startY + endY) / 2 - 4}
                  fill="var(--muted-foreground)"
                  fontSize="11"
                  paintOrder="stroke"
                  stroke="var(--background)"
                  strokeWidth="4"
                  textAnchor="middle"
                >
                  {conversationKnowledgeEdgeLabel(edge.relation)}
                </text>
              </g>
            )
          })}
        </svg>
        {positions.map((node) => (
          <button
            key={node.id}
            type="button"
            data-current={node.item?.id === selectedItemId || undefined}
            onClick={() => {
              onSelectNode?.(node)
              if (node.item) {
                setFocusedNode((current) =>
                  toggleFocusedNode(current, node.id, viewMode, projectId)
                )
                onSelectItem(node.item)
              } else {
                setFocusedNode((current) =>
                  toggleFocusedNode(current, node.id, viewMode, projectId)
                )
              }
            }}
            className="absolute rounded-xl border border-border/70 bg-background/95 px-3 py-2 text-left shadow-xs outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 data-[current=true]:border-foreground/40 data-[current=true]:bg-accent"
            style={{ height: node.height, left: node.x, top: node.y, width: nodeWidth }}
          >
            <span className="block truncate text-xs font-medium">{node.label}</span>
            <span className="mt-1 block text-[10px] capitalize text-muted-foreground">
              {conversationKnowledgeNodeTypeLabel(node.type)} · {node.itemCount}
            </span>
            {node.sourceBacked ? (
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                {conversationKnowledgeSourceStatusLabel(node.sourceBacked)}
              </span>
            ) : null}
            {node.item ? (
              <span className="mt-0.5 block truncate text-[10px] text-muted-foreground">
                {node.item.knowledge.title ?? node.item.knowledge.summary}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  )
}

function conversationKnowledgeNodeTypeLabel(type: ConversationKnowledgeGraphNode['type']): string {
  switch (type) {
    case 'project':
      return translate('conversationKnowledge.nodeType.project', 'Project')
    case 'workspace':
      return translate('conversationKnowledge.nodeType.workspace', 'Workspace')
    case 'digest':
      return translate('conversationKnowledge.nodeType.digest', 'Conversation digest')
    case 'concept':
      return translate('conversationKnowledge.nodeType.concept', 'Concept')
    case 'candidate':
      return translate('conversationKnowledge.nodeType.candidate', 'Knowledge candidate')
    case 'statement':
      return translate('conversationKnowledge.nodeType.statement', 'Source-backed statement')
    case 'note':
      return translate('conversationKnowledge.nodeType.note', 'Knowledge note')
  }
}

function conversationKnowledgeEdgeLabel(relation: ConversationKnowledgeGraphRelation): string {
  switch (relation) {
    case 'belongs-to':
      return translate('conversationKnowledge.relation.belongsTo', 'belongs to')
    case 'occurred-in':
      return translate('conversationKnowledge.relation.occurredIn', 'occurred in')
    case 'about':
      return translate('conversationKnowledge.relation.about', 'about')
    case 'mentions':
      return translate('conversationKnowledge.relation.mentions', 'mentions')
    case 'contains':
      return translate('conversationKnowledge.relation.contains', 'contains')
    case 'records':
      return translate('conversationKnowledge.relation.records', 'records')
    case 'organizes':
      return translate('conversationKnowledge.relation.organizes', 'organizes into')
    case 'supports':
      return translate('conversationKnowledge.relation.supports', 'supports')
  }
}

function conversationKnowledgeSourceStatusLabel(
  sourceBacked: NonNullable<ConversationKnowledgeGraphNode['sourceBacked']>
): string {
  const reliability =
    sourceBacked.reliability === 'user-confirmed'
      ? translate('conversationKnowledge.detail.handoffUserConfirmed', 'User confirmed')
      : sourceBacked.reliability === 'verified'
        ? translate('conversationKnowledge.detail.handoffVerified', 'Verified')
        : sourceBacked.reliability === 'inferred'
          ? translate('conversationKnowledge.detail.handoffInferred', 'Inferred')
          : translate('conversationKnowledge.detail.handoffProposal', 'Proposal')
  const lifecycle = sourceBacked.lifecycle?.status
  if (!lifecycle || lifecycle === 'active') {
    return reliability
  }
  const lifecycleLabel =
    lifecycle === 'superseded'
      ? translate('conversationKnowledge.detail.handoffSuperseded', 'Superseded')
      : lifecycle === 'conflicted'
        ? translate('conversationKnowledge.detail.handoffConflicted', 'Conflicted')
        : translate('conversationKnowledge.detail.handoffExpired', 'Expired')
  return `${reliability} · ${lifecycleLabel}`
}

export function toggleFocusedNode(
  current: FocusedNode | null,
  id: string,
  viewMode: FocusedNode['viewMode'],
  projectId: string | null
): FocusedNode | null {
  return current?.id === id && current.viewMode === viewMode && current.projectId === projectId
    ? null
    : { id, viewMode, projectId }
}

export function focusConversationKnowledgeGraph(
  graph: ConversationKnowledgeGraph,
  focusedNodeId: string | null
): ConversationKnowledgeGraph {
  if (!focusedNodeId || !graph.nodes.some((node) => node.id === focusedNodeId)) {
    return graph
  }
  const relatedIds = new Set(
    graph.edges.flatMap((edge) =>
      edge.source === focusedNodeId || edge.target === focusedNodeId
        ? [edge.source, edge.target]
        : []
    )
  )
  relatedIds.add(focusedNodeId)
  return {
    nodes: graph.nodes.filter((node) => relatedIds.has(node.id)),
    edges: graph.edges.filter((edge) => relatedIds.has(edge.source) && relatedIds.has(edge.target))
  }
}

export function positionConversationKnowledgeGraphNodes(
  graph: ConversationKnowledgeGraph,
  canvasWidth: number,
  nodeWidth = conversationKnowledgeGraphNodeWidth(graph, canvasWidth)
): PositionedNode[] {
  const columnX = conversationKnowledgeGraphColumnPositions(graph, canvasWidth, nodeWidth)
  const ordered = [...graph.nodes].sort(
    (left, right) =>
      columnX[left.type] - columnX[right.type] ||
      (right.relevance ?? 0) - (left.relevance ?? 0) ||
      right.itemCount - left.itemCount ||
      left.label.localeCompare(right.label)
  )
  const nextYByColumn = new Map<number, number>()
  return ordered.map((node) => {
    const x = columnX[node.type]
    const height = conversationKnowledgeGraphNodeHeight(node)
    const y = nextYByColumn.get(x) ?? NODE_VERTICAL_GAP
    nextYByColumn.set(x, y + height + NODE_VERTICAL_GAP)
    return {
      ...node,
      height,
      x,
      y
    }
  })
}

function conversationKnowledgeGraphNodeHeight(node: ConversationKnowledgeGraphNode): number {
  const detailLines = Number(Boolean(node.sourceBacked)) + Number(Boolean(node.item))
  return NODE_MIN_HEIGHT + detailLines * NODE_DETAIL_LINE_HEIGHT
}

export function conversationKnowledgeGraphNodeWidth(
  graph: ConversationKnowledgeGraph,
  canvasWidth: number
): number {
  const columnCount = graph.nodes.some((node) => node.type === 'note') ? 4 : 3
  const gap = 10
  return Math.min(
    MAX_NODE_WIDTH,
    Math.max(
      MIN_NODE_WIDTH,
      Math.floor((canvasWidth - GRAPH_SIDE_PADDING * 2 - gap * (columnCount - 1)) / columnCount)
    )
  )
}

function conversationKnowledgeGraphColumnPositions(
  graph: ConversationKnowledgeGraph,
  canvasWidth: number,
  nodeWidth: number
): Record<ConversationKnowledgeGraphNode['type'], number> {
  const hasNotes = graph.nodes.some((node) => node.type === 'note')
  const lastColumn = canvasWidth - GRAPH_SIDE_PADDING - nodeWidth
  const digest = Math.round((GRAPH_SIDE_PADDING + lastColumn) / (hasNotes ? 3 : 2))
  const concept = hasNotes ? Math.round((GRAPH_SIDE_PADDING + lastColumn * 2) / 3) : lastColumn
  return {
    project: GRAPH_SIDE_PADDING,
    workspace: GRAPH_SIDE_PADDING,
    digest,
    concept,
    candidate: concept,
    statement: concept,
    note: lastColumn
  }
}
