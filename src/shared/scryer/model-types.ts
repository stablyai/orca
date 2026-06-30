export type C4Kind =
  | 'person'
  | 'system'
  | 'container'
  | 'component'
  | 'operation'
  | 'process'
  | 'model'

export type C4Shape =
  | 'rectangle'
  | 'person'
  | 'cylinder'
  | 'pipe'
  | 'trapezoid'
  | 'bucket'
  | 'hexagon'

export type Status = 'proposed' | 'implemented' | 'verified' | 'vagrant'

export type ContractImage = {
  filename: string
  mimeType: string
  data: string
}

export type ContractItem =
  | string
  | { text: string; passed?: boolean; url?: string; image?: ContractImage }

export type Contract = {
  expect: ContractItem[]
  ask: ContractItem[]
  never: ContractItem[]
}

export type SourceLocation = {
  pattern: string
  line?: number
  endLine?: number
  command?: string
}

export type ModelValidationWarning = {
  kind: 'missing-mention'
  path: string
  reference: string
  message: string
}

export type ModelProperty = {
  label: string
  description: string
}

export type C4NodeData = {
  name: string
  description: string
  kind: C4Kind
  technology?: string
  external?: boolean
  expanded?: boolean
  shape?: C4Shape
  sources?: { pattern: string; comment: string }[]
  status?: Status
  statusReason?: string
  contract?: Contract
  notes?: string[]
  properties?: ModelProperty[]
  _reference?: boolean
  _relationships?: { direction: 'in' | 'out'; label: string; method?: string }[]
  _operations?: { id: string; name: string }[]
  _needsLayout?: boolean
  [key: string]: unknown
}

export type C4Node = {
  id: string
  type?: 'c4' | 'operation' | 'process' | 'model'
  position?: { x: number; y: number }
  data: C4NodeData
  parentId?: string
  selected?: boolean
  measured?: unknown
}

export type C4EdgeData = {
  label: string
  method?: string
  _route?: { x: number; y: number }[]
  _bundleAngle?: number
  [key: string]: unknown
}

export type C4Edge = {
  id: string
  source: string
  target: string
  sourceHandle?: string
  targetHandle?: string
  data?: C4EdgeData
  selected?: boolean
}

export type Group = {
  id: string
  name: string
  description?: string
  memberIds: string[]
  parentGroupId?: string
  contract?: Contract
}

export type FlowBranch = {
  condition: string
  steps: FlowStep[]
}

export type FlowStep = {
  id: string
  label?: string
  description?: string
  branches?: FlowBranch[]
}

export type FlowTransition = {
  source: string
  target: string
  label?: string
}

export type Flow = {
  id: string
  name: string
  description?: string
  steps: FlowStep[]
  transitions?: FlowTransition[]
}

export type StartingLevel = 'system' | 'container' | 'component'

export type C4ModelData = {
  nodes: C4Node[]
  edges: C4Edge[]
  startingLevel?: StartingLevel
  sourceMap?: Record<string, SourceLocation[]>
  projectPath?: string
  refPositions?: Record<string, { x: number; y: number }>
  groups?: Group[]
  flows?: Flow[]
  validationWarnings?: ModelValidationWarning[]
}

export type DriftedNode = {
  nodeId: string
  nodeName: string
  patterns: string[]
}

export type DriftReport = {
  nodes: DriftedNode[]
  structureChanged: boolean
}

export type ScryerToolName =
  | 'list_models'
  | 'set_model'
  | 'get_model'
  | 'get_node'
  | 'add_nodes'
  | 'set_node'
  | 'update_nodes'
  | 'delete_nodes'
  | 'add_edges'
  | 'update_edges'
  | 'delete_edges'
  | 'update_source_map'
  | 'set_flows'
  | 'delete_flow'
  | 'set_groups'
  | 'delete_group'
  | 'set_implementing'
  | 'get_rules'
  | 'validate_model'
  | 'get_task'
  | 'get_changes'
  | 'get_structure'

export type ScryerToolCall = {
  toolName: ScryerToolName
  arguments: Record<string, unknown>
}

export type ScryerToolResult =
  | { ok: true; content: string; data?: unknown }
  | { ok: false; content: string; data?: unknown }
