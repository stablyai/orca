export type ArchitectureViewKind = 'person' | 'system' | 'container' | 'component' | 'symbol'

export type ArchitectureViewResponsibility = {
  id: string
  statement: string
  vagrant?: boolean
  stale?: boolean
  staleProposal?: string
  directives?: string[]
  lastTouchedAt?: number
}

export type ArchitectureViewProperty = {
  label: string
  description?: string
  vagrant?: boolean
  stale?: boolean
  lastTouchedAt?: number
}

export type ArchitectureViewSourceLocation = {
  pattern: string
  symbol?: string
  line?: number
  endLine?: number
  command?: string
}

export type ArchitectureViewBoundarySource = {
  pattern: string
  comment?: string
}

export type ArchitectureViewNode = {
  id: string
  kind: ArchitectureViewKind
  name: string
  parentId?: string
  external?: boolean
  technology?: string
  description?: string
  vagrant?: boolean
  stale?: boolean
  responsibilities?: ArchitectureViewResponsibility[]
  properties?: ArchitectureViewProperty[]
  icon?: string
  visual?: boolean
  appearance?: Record<string, unknown>
  notes?: string
}

export type ArchitectureViewLink = {
  id: string
  src: string
  dst: string
  label: string
  method?: string
}

export type ArchitectureViewGroup = {
  id: string
  name: string
  description?: string
  memberIds: string[]
  parentGroupId?: string
  parentNodeId?: string | null
  responsibilities?: ArchitectureViewResponsibility[]
  icon?: string
}

export type ArchitectureViewRefreshStrategy = {
  strategy: 'overview' | 'focus'
  focusNodeId?: string
}

export type ArchitectureViewTreeRow = {
  id: string
  kind: ArchitectureViewKind
  name: string
  depth: number
  path: string
  childCount: number
  parentId?: string
  stale?: boolean
  vagrant?: boolean
}

export type ArchitectureViewSourceMapRow = {
  ownerId: string
  locations: ArchitectureViewSourceLocation[]
}

export type ArchitectureViewBoundaryRow = {
  nodeId: string
  sources: ArchitectureViewBoundarySource[]
}

export type ArchitectureViewSelectedDetails = {
  node: ArchitectureViewNode
  sourceLocations: ArchitectureViewSourceLocation[]
  boundarySources: ArchitectureViewBoundarySource[]
  incomingLinks: ArchitectureViewLink[]
  outgoingLinks: ArchitectureViewLink[]
  groups: ArchitectureViewGroup[]
}

export type ArchitectureViewDriftIndicator = {
  nodeId: string
  stale?: boolean
  vagrant?: boolean
}

export type ArchitectureViewDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code: string
  message: string
  path?: string
}

export type ArchitectureViewRecommendedNextRead = {
  operationId: 'scryer.model.read' | 'scryer.model.search' | 'scryer.model.query'
  input: Record<string, unknown>
  reason: string
}

export type ArchitectureViewPendingSummary = {
  total: number
  toImplement?: number
  toReimplement?: number
  toMove?: number
  toDelete?: number
  toRepoint?: number
}

export type ArchitectureViewDto = {
  version: '0.3'
  layer: 'plan' | 'committed'
  nodes: ArchitectureViewNode[]
  links: ArchitectureViewLink[]
  groups: ArchitectureViewGroup[]
  sourceMap: Record<string, ArchitectureViewSourceLocation[]>
  boundaries: Record<string, ArchitectureViewBoundarySource[]>
  treeRows: ArchitectureViewTreeRow[]
  sourceMapRows: ArchitectureViewSourceMapRow[]
  boundaryRows: ArchitectureViewBoundaryRow[]
  driftIndicators: ArchitectureViewDriftIndicator[]
  diagnostics: ArchitectureViewDiagnostic[]
  recommendedNextReads: ArchitectureViewRecommendedNextRead[]
  selectedDetails?: ArchitectureViewSelectedDetails
  pending?: ArchitectureViewPendingSummary
  summary: {
    nodeCount: number
    linkCount: number
    groupCount: number
  }
  refresh: ArchitectureViewRefreshStrategy
}

export type ArchitectureViewFieldError = {
  path: string
  message: string
  code?: string
}

export type ArchitectureViewError = {
  code: string
  message: string
  details?: Record<string, unknown>
  fieldErrors?: ArchitectureViewFieldError[]
  path?: string
  jsonPointer?: string
  retryable?: boolean
}

export type ArchitectureViewReadResult =
  | {
      ok: true
      operationId: string
      requestId: string
      result: ArchitectureViewDto
      meta?: Record<string, unknown>
    }
  | {
      ok: false
      operationId: string
      requestId: string
      error: ArchitectureViewError
      meta?: Record<string, unknown>
    }
