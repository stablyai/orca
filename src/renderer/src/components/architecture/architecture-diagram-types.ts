export type ArchitectureDiagramKind =
  | 'person'
  | 'system'
  | 'container'
  | 'component'
  | 'operation'
  | 'process'
  | 'model'

export type ArchitectureDiagramShape =
  | 'rectangle'
  | 'person'
  | 'cylinder'
  | 'pipe'
  | 'trapezoid'
  | 'bucket'
  | 'hexagon'

export type ArchitectureStatus = 'proposed' | 'implemented' | 'verified' | 'vagrant'

export type ArchitectureContractImage = {
  filename: string
  mimeType: string
  data: string
}

export type ArchitectureContractItem =
  | string
  | { text: string; passed?: boolean; url?: string; image?: ArchitectureContractImage }

export type ArchitectureContract = {
  expect: ArchitectureContractItem[]
  ask: ArchitectureContractItem[]
  never: ArchitectureContractItem[]
}

export type ArchitectureSourceLocation = {
  pattern: string
  symbol?: string
  line?: number
  endLine?: number
  command?: string
}

export type ArchitectureBoundarySource = {
  pattern: string
  comment?: string
}

export type ArchitectureValidationWarning = {
  kind: 'missing-mention'
  path: string
  reference: string
  message: string
}

export type ArchitectureModelProperty = {
  label: string
  description: string
}

export type ArchitectureDiagramNodeData = {
  name: string
  description: string
  kind: ArchitectureDiagramKind
  technology?: string
  external?: boolean
  expanded?: boolean
  shape?: ArchitectureDiagramShape
  sources?: { pattern: string; comment: string }[]
  status?: ArchitectureStatus
  statusReason?: string
  contract?: ArchitectureContract
  notes?: string[]
  properties?: ArchitectureModelProperty[]
  _reference?: boolean
  _relationships?: { direction: 'in' | 'out'; label: string; method?: string }[]
  _operations?: { id: string; name: string; status?: ArchitectureStatus }[]
  _processes?: { id: string; name: string; status?: ArchitectureStatus }[]
  _models?: { id: string; name: string; status?: ArchitectureStatus }[]
  _needsLayout?: boolean
  [key: string]: unknown
}

export type ArchitectureDiagramNode = {
  id: string
  type?: 'architecture' | 'operation' | 'process' | 'model'
  position?: { x: number; y: number }
  data: ArchitectureDiagramNodeData
  parentId?: string
  selected?: boolean
  measured?: unknown
}

export type ArchitectureDiagramLinkData = {
  label: string
  method?: string
  _route?: { x: number; y: number }[]
  _bundleAngle?: number
  [key: string]: unknown
}

export type ArchitectureDiagramLink = {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data?: ArchitectureDiagramLinkData
  selected?: boolean
}

export type ArchitectureGroup = {
  id: string
  name: string
  description?: string
  memberIds: string[]
  parentGroupId?: string
  parentNodeId?: string | null
  contract?: ArchitectureContract
}

export type ArchitectureDiagramModel = {
  nodes: ArchitectureDiagramNode[]
  links: ArchitectureDiagramLink[]
  startingLevel?: 'system' | 'container' | 'component'
  sourceMap?: Record<string, ArchitectureSourceLocation[]>
  boundaries?: Record<string, ArchitectureBoundarySource[]>
  projectPath?: string
  refPositions?: Record<string, { x: number; y: number }>
  groups?: ArchitectureGroup[]
  validationWarnings?: ArchitectureValidationWarning[]
}

export type ArchitectureDriftedNode = {
  nodeId: string
  nodeName: string
  patterns: string[]
}

export type ArchitectureDriftReport = {
  nodes: ArchitectureDriftedNode[]
  structureChanged: boolean
}
