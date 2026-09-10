import type {
  MaestroDocument,
  MaestroDocumentAuthoringMutation,
  MaestroDocumentEdge,
  MaestroDocumentNodeInput,
  MaestroEdgeDirection,
  MaestroEdgeType
} from '../../../../shared/maestro-contract'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { MaestroCanvasViewport } from './maestro-canvas-viewport'
import type { MaestroRunProgress } from '../../../../shared/maestro-run-progress'
import type { MaestroBrowserSurfaceReceipt } from '../../../../shared/maestro-browser-surface'
import { maestroWindowDefaultSize } from './maestro-window-model'

export type MaestroCanvasPoint = { x: number; y: number }
export type MaestroCanvasSize = { width: number; height: number }
export type MaestroAuthoringDocument = MaestroDocument
export type MaestroAuthoringNode = MaestroDocumentNodeInput
export type MaestroAuthoringEdge = MaestroDocumentEdge
export type MaestroCanvasEdgeType = MaestroEdgeType
export type MaestroAuthoringEdgeDirection = MaestroEdgeDirection
export type { MaestroEdgeDirection }
export const MAESTRO_NOTE_MAX_BYTES = 64 * 1024
export const INITIAL_MAESTRO_VIEWPORT: MaestroCanvasViewport = {
  center: { x: 0, y: 0 },
  zoom: 1
}
export type MaestroMutationResult = { outcome: 'applied' | 'conflict'; revision: number }

export type MaestroCanvasNode = {
  id: string
  title: string
  summary: string
  status: string
  rawStatus?: string
  position: MaestroCanvasPoint
  agent?: TuiAgent
  model?: string
  effort?: string
  kind?: 'note' | 'projected'
  markdown?: string
  noteRevision?: number
  taskId?: string
  attemptId?: string
  contextSnapshotId?: string
  projectedType?:
    | 'task'
    | 'attempt'
    | 'note-reference'
    | 'terminal-receipt'
    | 'evidence'
    | 'cleanup'
    | 'portal'
    | 'run-progress'
  runProgress?: MaestroRunProgress
  requestedAgent?: string | null
  resolvedAgent?: string | null
  requestedModel?: string | null
  resolvedModel?: string | null
  requestedEffort?: string | null
  resolvedEffort?: string | null
  fallbackReason?: string | null
  role?: string
  terminalId?: string | null
  live?: boolean
  executionHostId?: string
  workspaceKey?: string
  runId?: string
  revision?: number
  parentWorkspaceKey?: string
  destinationExecutionHostId?: string
  destinationWorkspaceKey?: string
  portalDirection?: 'to-execution' | 'back-to-home'
  browserSurface?: MaestroBrowserSurfaceReceipt
  browserPreviewUrl?: string
  /** Session-local window size. Absent until the operator resizes the window. */
  size?: MaestroCanvasSize
}
export type MaestroCanvasEdge = {
  id: string
  sourceId: string
  targetId: string
  type?: MaestroEdgeType
  direction?: MaestroEdgeDirection
  projected?: boolean
  contextSnapshotId?: string
}
export type MaestroSpatialGraph = {
  nodes: readonly MaestroCanvasNode[]
  edges: readonly MaestroCanvasEdge[]
}

export function noteByteCount(markdown: string): number {
  return new TextEncoder().encode(markdown).byteLength
}

export function createMaestroMutationId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

export function isMaestroMutationResult(value: unknown): value is MaestroMutationResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'outcome' in value &&
    'revision' in value &&
    (value.outcome === 'applied' || value.outcome === 'conflict')
  )
}

export function canvasPointerToWorld(
  viewport: MaestroCanvasViewport,
  canvas: MaestroCanvasSize,
  pointer: MaestroCanvasPoint
): MaestroCanvasPoint {
  if (canvas.width <= 0 || canvas.height <= 0) {
    return viewport.center
  }
  return {
    x: viewport.center.x - canvas.width / viewport.zoom / 2 + pointer.x / viewport.zoom,
    y: viewport.center.y - canvas.height / viewport.zoom / 2 + pointer.y / viewport.zoom
  }
}

export function placeMaestroContextMenu(
  pointer: MaestroCanvasPoint,
  menu: MaestroCanvasSize,
  canvas: MaestroCanvasSize,
  gutter = 8
): MaestroCanvasPoint {
  return {
    x: Math.max(gutter, Math.min(pointer.x, canvas.width - menu.width - gutter)),
    y: Math.max(gutter, Math.min(pointer.y, canvas.height - menu.height - gutter))
  }
}

export function createMaestroNoteAtPointer(params: {
  title: string
  markdown: string
  pointer: MaestroCanvasPoint
  viewport: MaestroCanvasViewport
  canvas: MaestroCanvasSize
}): MaestroDocumentNodeInput {
  return {
    kind: 'note',
    title: params.title.trim() || 'Untitled note',
    markdown: params.markdown,
    note_revision: 1,
    position: canvasPointerToWorld(params.viewport, params.canvas, params.pointer)
  }
}

export function createMaestroUserEdge(params: {
  id: string
  sourceId: string
  targetId: string
  type: MaestroCanvasEdgeType
  direction?: MaestroAuthoringEdgeDirection
  contextNoteId?: string
  expectedNoteRevision?: number
}): Extract<MaestroDocumentAuthoringMutation['operation'], { kind: 'create-edge' }> {
  if (params.sourceId === params.targetId) {
    throw new Error('A Maestro edge needs two endpoints.')
  }
  if (params.type === 'context_for') {
    const expectedNoteRevision = params.expectedNoteRevision
    if (
      !params.contextNoteId ||
      !Number.isInteger(expectedNoteRevision) ||
      expectedNoteRevision === undefined ||
      expectedNoteRevision < 1
    ) {
      throw new Error('Context links need an expected note revision.')
    }
    return {
      kind: 'create-edge',
      id: params.id,
      source_id: params.sourceId,
      target_id: params.targetId,
      type: params.type,
      direction: params.direction ?? 'forward',
      context_note_id: params.contextNoteId,
      expected_note_revision: expectedNoteRevision
    }
  }
  return {
    kind: 'create-edge',
    id: params.id,
    source_id: params.sourceId,
    target_id: params.targetId,
    type: params.type,
    direction: params.direction ?? 'forward'
  }
}

export function isMaestroEdgeEditable(edge: { projected?: boolean }): boolean {
  return !edge.projected
}

export function maestroNodeBounds(node: MaestroCanvasNode) {
  const size = node.size ?? maestroWindowDefaultSize(node)
  return { x: node.position.x, y: node.position.y, width: size.width, height: size.height }
}

function fallbackNodes(document: MaestroDocument): MaestroCanvasNode[] {
  const documentNodes = document.nodes as Record<string, MaestroDocumentNodeInput>
  return Object.entries(documentNodes).map(([id, node], index) => ({
    id,
    title: node.title ?? id,
    summary: node.kind === 'note' ? 'Markdown note' : 'Canvas node',
    status: node.kind === 'note' ? `Saved · revision ${node.note_revision ?? 1}` : 'Positioned',
    position: node.position ?? { x: (index % 4) * 288, y: Math.floor(index / 4) * 184 },
    kind: node.kind === 'note' ? 'note' : 'projected',
    markdown: node.markdown,
    noteRevision: node.note_revision,
    contextSnapshotId: node.context_snapshot_id
  }))
}

export function graphFromMaestroDocument(
  document: MaestroDocument,
  graph?: MaestroSpatialGraph
): MaestroSpatialGraph {
  const documentNodes = document.nodes as Record<string, MaestroDocumentNodeInput>
  const source = graph ?? { nodes: fallbackNodes(document), edges: [] }
  const contextSnapshotByNode = new Map<string, string>()
  for (const edge of document.edges ?? []) {
    if (edge.type === 'context_for' && edge.context_snapshot_id && edge.context_note_id) {
      contextSnapshotByNode.set(edge.context_note_id, edge.context_snapshot_id)
    }
  }
  const projectedNodes = source.nodes.map((node) => ({
    ...node,
    position: documentNodes[node.id]?.position ?? node.position,
    contextSnapshotId: contextSnapshotByNode.get(node.id)
  }))
  const known = new Set(projectedNodes.map((node) => node.id))
  const notes = Object.entries(documentNodes)
    .filter(([id, node]) => node.kind === 'note' && !known.has(id))
    .map(([id, node]) => ({
      id,
      title: node.title ?? id,
      summary: 'Markdown note',
      status: `Saved · revision ${node.note_revision ?? 1}`,
      position: node.position ?? { x: 0, y: 0 },
      kind: 'note' as const,
      markdown: node.markdown,
      noteRevision: node.note_revision,
      contextSnapshotId: contextSnapshotByNode.get(id)
    }))
  const edges = (document.edges ?? []).map((edge) => ({
    id: edge.id,
    sourceId: edge.source_id,
    targetId: edge.target_id,
    type: edge.type,
    direction: edge.direction,
    projected: false,
    contextSnapshotId: edge.context_snapshot_id
  }))
  return {
    nodes: [...projectedNodes, ...notes],
    edges: [
      ...source.edges.map((edge) => ({ ...edge, projected: edge.projected ?? true })),
      ...edges
    ]
  }
}

export function nextDirectionalMaestroNode(
  current: MaestroCanvasNode,
  nodes: readonly MaestroCanvasNode[],
  direction: MaestroCanvasPoint
): MaestroCanvasNode | null {
  let closest: { node: MaestroCanvasNode; score: number } | null = null
  for (const candidate of nodes) {
    if (candidate.id === current.id) {
      continue
    }
    const x = candidate.position.x - current.position.x
    const y = candidate.position.y - current.position.y
    const forward = x * direction.x + y * direction.y
    if (forward <= 0) {
      continue
    }
    const score = forward + Math.abs(x * direction.y - y * direction.x) * 2
    if (!closest || score < closest.score) {
      closest = { node: candidate, score }
    }
  }
  return closest?.node ?? null
}
