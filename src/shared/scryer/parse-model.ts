/* eslint-disable max-lines -- Why: this shared parser owns all legacy Scryer model normalization so malformed models are cleaned before they reach IPC, MCP, or the renderer. */
import type {
  C4Edge,
  C4Kind,
  C4ModelData,
  C4Node,
  C4NodeData,
  Contract,
  ContractImage,
  ContractItem,
  Flow,
  FlowBranch,
  FlowStep,
  FlowTransition,
  Group,
  ModelValidationWarning,
  SourceLocation,
  Status
} from './model-types'

const VALID_STATUSES = new Set<Status>(['proposed', 'implemented', 'verified', 'vagrant'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function normalizeContractImage(raw: unknown): ContractImage | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const dataUrl = typeof raw.dataUrl === 'string' ? raw.dataUrl : undefined
  const rawData = typeof raw.data === 'string' ? raw.data : dataUrl
  if (!rawData) {
    return undefined
  }
  const match = rawData.match(/^data:([^;,]+);base64,(.*)$/)
  const data = match ? match[2] : rawData
  const mimeType =
    typeof raw.mimeType === 'string'
      ? raw.mimeType
      : typeof raw.type === 'string'
        ? raw.type
        : (match?.[1] ?? 'application/octet-stream')
  return {
    filename:
      typeof raw.filename === 'string' && raw.filename.trim() ? raw.filename.trim() : 'image',
    mimeType,
    data
  }
}

function normalizeContractItem(value: unknown): ContractItem | null {
  if (typeof value === 'string') {
    return value.trim()
  }
  if (!isRecord(value) || typeof value.text !== 'string') {
    return null
  }
  const image = normalizeContractImage(value.image)
  const url = typeof value.url === 'string' ? value.url.trim() || undefined : undefined
  const item = {
    text: value.text.trim(),
    ...(typeof value.passed === 'boolean' ? { passed: value.passed } : {}),
    ...(url ? { url } : {}),
    ...(image ? { image } : {})
  }
  return item
}

function migrateContract(raw: unknown): Contract {
  const empty: Contract = { expect: [], ask: [], never: [] }
  if (!isRecord(raw)) {
    return empty
  }
  const migrate = (value: unknown): ContractItem[] => {
    if (Array.isArray(value)) {
      return value.map(normalizeContractItem).filter((item): item is ContractItem => item !== null)
    }
    if (typeof value === 'string') {
      return value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
    return []
  }
  return {
    expect: migrate(raw.expect ?? raw.always),
    ask: migrate(raw.ask),
    never: migrate(raw.never)
  }
}

function normalizeFlowStep(rawStep: unknown): FlowStep {
  const step = isRecord(rawStep) ? rawStep : {}
  const id =
    typeof step.id === 'string' && step.id.trim() ? step.id.trim() : globalThis.crypto.randomUUID()
  const branches = Array.isArray(step.branches) ? step.branches.map(normalizeFlowBranch) : undefined
  return {
    ...(step as Partial<FlowStep>),
    id,
    label: typeof step.label === 'string' ? step.label : '',
    description: typeof step.description === 'string' ? step.description : '',
    branches
  }
}

function normalizeFlowBranch(rawBranch: unknown): FlowBranch {
  const branch = isRecord(rawBranch) ? rawBranch : {}
  return {
    condition: typeof branch.condition === 'string' ? branch.condition : '',
    steps: Array.isArray(branch.steps) ? branch.steps.map(normalizeFlowStep) : []
  }
}

function migrateFlowTransitions(steps: FlowStep[], transitions: FlowTransition[]): FlowStep[] {
  if (transitions.length === 0) {
    return steps
  }
  const stepIds = new Set(steps.map((step) => step.id))
  const adjacency = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  for (const step of steps) {
    adjacency.set(step.id, [])
    inDegree.set(step.id, 0)
  }
  for (const transition of transitions) {
    if (stepIds.has(transition.source) && stepIds.has(transition.target)) {
      adjacency.get(transition.source)?.push(transition.target)
      inDegree.set(transition.target, (inDegree.get(transition.target) ?? 0) + 1)
    }
  }
  const queue = steps.filter((step) => (inDegree.get(step.id) ?? 0) === 0).map((step) => step.id)
  const sorted: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    sorted.push(id)
    for (const next of adjacency.get(id) ?? []) {
      const nextDegree = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, nextDegree)
      if (nextDegree === 0) {
        queue.push(next)
      }
    }
  }
  for (const step of steps) {
    if (!sorted.includes(step.id)) {
      sorted.push(step.id)
    }
  }
  const stepById = new Map(steps.map((step) => [step.id, step]))
  return sorted.map((id) => {
    const { position: _position, ...step } = stepById.get(id)! as FlowStep & { position?: unknown }
    return step
  })
}

function nodeTypeForKind(kind: string): C4Node['type'] {
  if (kind === 'operation' || kind === 'process' || kind === 'model') {
    return kind
  }
  return 'c4'
}

function isC4Kind(value: unknown): value is C4Kind {
  return (
    value === 'person' ||
    value === 'system' ||
    value === 'container' ||
    value === 'component' ||
    value === 'operation' ||
    value === 'process' ||
    value === 'model'
  )
}

function normalizeNodeSources(value: unknown): C4NodeData['sources'] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const sources = value
    .filter(isRecord)
    .map((source) => ({
      pattern: String(source.pattern ?? ''),
      comment: String(source.comment ?? '')
    }))
    .filter((source) => source.pattern)
  return sources.length > 0 ? sources : undefined
}

function normalizeStrictNode(rawNode: unknown, boundaries: unknown): C4Node {
  const node = isRecord(rawNode) ? rawNode : {}
  const id = typeof node.id === 'string' ? node.id : globalThis.crypto.randomUUID()
  const appearance = isRecord(node.appearance) ? node.appearance : {}
  const rawKind = node.kind
  const symbolKind = isC4Kind(appearance.symbolKind) ? appearance.symbolKind : 'operation'
  const kind: C4Kind = rawKind === 'symbol' ? symbolKind : isC4Kind(rawKind) ? rawKind : 'system'
  const rawContract = appearance.contract ?? node.contract
  const contract = rawContract ? migrateContract(rawContract) : undefined
  const rawStatus = appearance.status ?? node.status
  const status =
    typeof rawStatus === 'string' && VALID_STATUSES.has(rawStatus as Status)
      ? (rawStatus as Status)
      : undefined
  const sources = isRecord(boundaries) ? normalizeNodeSources(boundaries[id]) : undefined
  return {
    id,
    type: nodeTypeForKind(kind),
    ...(typeof node.parentId === 'string' ? { parentId: node.parentId } : {}),
    position: { x: 0, y: 0 },
    data: {
      name: typeof node.name === 'string' ? node.name : String(node.id ?? 'Unnamed'),
      description: typeof node.description === 'string' ? node.description : '',
      kind,
      ...(typeof node.technology === 'string' ? { technology: node.technology } : {}),
      ...(typeof node.external === 'boolean' ? { external: node.external } : {}),
      ...(typeof appearance.shape === 'string'
        ? { shape: appearance.shape as C4NodeData['shape'] }
        : {}),
      ...(sources ? { sources } : {}),
      ...(status ? { status } : {}),
      ...(contract ? { contract } : {}),
      ...(typeof node.notes === 'string' ? { notes: node.notes.split('\n').filter(Boolean) } : {}),
      ...(Array.isArray(node.properties)
        ? {
            properties: node.properties.filter(isRecord).map((property) => ({
              label: String(property.label ?? ''),
              description: String(property.description ?? '')
            }))
          }
        : {}),
      _needsLayout: true
    }
  }
}

function normalizeNode(rawNode: unknown): C4Node {
  const node = isRecord(rawNode) ? rawNode : {}
  const rawData = isRecord(node.data) ? node.data : {}
  const kind = typeof rawData.kind === 'string' ? rawData.kind : 'system'
  const rawContract = rawData.contract ?? rawData.guidelines
  const contract = rawContract ? migrateContract(rawContract) : undefined
  const rawNotes = rawData.notes
  const notes =
    typeof rawNotes === 'string'
      ? rawNotes.split('\n').filter(Boolean)
      : Array.isArray(rawNotes) && rawNotes.length > 0
        ? rawNotes.filter((item): item is string => typeof item === 'string')
        : undefined
  const hasPosition = isRecord(node.position)
  const status =
    typeof rawData.status === 'string' && VALID_STATUSES.has(rawData.status as Status)
      ? (rawData.status as Status)
      : undefined
  const stripStatus = kind === 'person' || (kind === 'system' && rawData.external === true)
  const data: C4NodeData = {
    ...(rawData as Partial<C4NodeData>),
    name: typeof rawData.name === 'string' ? rawData.name : String(node.id ?? 'Unnamed'),
    description: typeof rawData.description === 'string' ? rawData.description : '',
    kind: kind as C4Kind,
    contract,
    sources: (rawData.sources ?? rawData.references) as C4NodeData['sources'],
    notes,
    status: stripStatus ? undefined : status,
    guidelines: undefined,
    references: undefined,
    ...(!hasPosition ? { _needsLayout: true } : {})
  }

  return {
    ...(node as Partial<C4Node>),
    id: typeof node.id === 'string' ? node.id : globalThis.crypto.randomUUID(),
    type: nodeTypeForKind(kind),
    position: hasPosition ? (node.position as { x: number; y: number }) : { x: 0, y: 0 },
    data
  }
}

function normalizeSourceLocation(rawLocation: unknown): SourceLocation | null {
  if (!isRecord(rawLocation) || typeof rawLocation.pattern !== 'string') {
    return null
  }
  const pattern = rawLocation.pattern.trim()
  if (!pattern) {
    return null
  }
  const rawLine = Number(rawLocation.line)
  const rawEndLine = Number(rawLocation.endLine)
  const line = Number.isInteger(rawLine) && rawLine > 0 ? rawLine : undefined
  const endLine = Number.isInteger(rawEndLine) && rawEndLine > 0 ? rawEndLine : undefined
  const normalizedLine =
    line !== undefined && endLine !== undefined && endLine < line ? endLine : line
  const normalizedEndLine =
    line !== undefined && endLine !== undefined && endLine < line ? line : endLine
  const command =
    typeof rawLocation.command === 'string' && rawLocation.command.trim()
      ? rawLocation.command.trim()
      : undefined
  return {
    pattern,
    ...(normalizedLine !== undefined ? { line: normalizedLine } : {}),
    ...(normalizedEndLine !== undefined ? { endLine: normalizedEndLine } : {}),
    ...(command ? { command } : {})
  }
}

function normalizeSourceMap(
  rawSourceMap: unknown,
  validKeys: Set<string>
): Record<string, SourceLocation[]> {
  if (!isRecord(rawSourceMap)) {
    return {}
  }
  const sourceMap: Record<string, SourceLocation[]> = {}
  for (const [key, value] of Object.entries(rawSourceMap)) {
    if (!validKeys.has(key) || !Array.isArray(value)) {
      continue
    }
    const locations = value
      .map(normalizeSourceLocation)
      .filter((location): location is SourceLocation => location !== null)
    if (locations.length > 0) {
      sourceMap[key] = locations
    }
  }
  return sourceMap
}

function normalizeGroups(rawGroups: unknown, nodeIds: Set<string>): Group[] {
  if (!Array.isArray(rawGroups)) {
    return []
  }
  return rawGroups.flatMap((rawGroup) => {
    const group = isRecord(rawGroup) ? rawGroup : {}
    if (typeof group.id !== 'string' || typeof group.name !== 'string') {
      return []
    }
    const rawMemberIds = Array.isArray(group.memberIds)
      ? group.memberIds
      : Array.isArray(group.nodeIds)
        ? group.nodeIds
        : []
    const memberIds = rawMemberIds.filter(
      (memberId): memberId is string => typeof memberId === 'string' && nodeIds.has(memberId)
    )
    return [
      {
        id: group.id,
        name: group.name,
        ...(typeof group.description === 'string' ? { description: group.description } : {}),
        memberIds,
        ...(typeof group.parentGroupId === 'string' ? { parentGroupId: group.parentGroupId } : {}),
        ...(group.contract ? { contract: migrateContract(group.contract) } : {})
      }
    ]
  })
}

function collectMentionWarnings(model: {
  nodes: C4Node[]
  flows: Flow[]
}): ModelValidationWarning[] {
  const knownMentions = new Set<string>()
  for (const node of model.nodes) {
    knownMentions.add(node.id)
    knownMentions.add(node.data.name)
  }
  const warnings: ModelValidationWarning[] = []
  const checkText = (text: string | undefined, path: string): void => {
    if (!text) {
      return
    }
    for (const match of text.matchAll(/@\[([^\]]+)\]/g)) {
      const reference = match[1]?.trim()
      if (!reference || knownMentions.has(reference)) {
        continue
      }
      warnings.push({
        kind: 'missing-mention',
        path,
        reference,
        message: `Mention '${reference}' does not match a model node`
      })
    }
  }
  const visitSteps = (flowId: string, steps: FlowStep[]): void => {
    for (const step of steps) {
      checkText(step.label, `flows.${flowId}.steps.${step.id}.label`)
      checkText(step.description, `flows.${flowId}.steps.${step.id}.description`)
      for (const branch of step.branches ?? []) {
        visitSteps(flowId, branch.steps)
      }
    }
  }
  for (const node of model.nodes) {
    checkText(node.data.description, `nodes.${node.id}.description`)
  }
  for (const flow of model.flows) {
    visitSteps(flow.id, flow.steps)
  }
  return warnings
}

export function parseModelData(raw: string): C4ModelData {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `Invalid Scryer model JSON: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  const root = isRecord(data) ? data : {}
  if (root.version === '0.3') {
    const nodes = Array.isArray(root.nodes)
      ? root.nodes.map((node) => normalizeStrictNode(node, root.boundaries))
      : []
    const nodeIds = new Set(nodes.map((node) => node.id))
    const seenEdgeIds = new Set<string>()
    const edges = (Array.isArray(root.links) ? root.links : []).flatMap((link): C4Edge[] => {
      if (!isRecord(link) || typeof link.id !== 'string' || seenEdgeIds.has(link.id)) {
        return []
      }
      const source = typeof link.src === 'string' ? link.src : undefined
      const target = typeof link.dst === 'string' ? link.dst : undefined
      if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) {
        return []
      }
      seenEdgeIds.add(link.id)
      return [
        {
          id: link.id,
          source,
          target,
          data: {
            label: typeof link.label === 'string' ? link.label : '',
            ...(typeof link.method === 'string' ? { method: link.method } : {})
          }
        }
      ]
    })
    const groups = normalizeGroups(root.groups, nodeIds)
    const sourceMap = normalizeSourceMap(root.sourceMap, nodeIds)
    const validationWarnings = collectMentionWarnings({ nodes, flows: [] })
    const parsed: C4ModelData = {
      nodes,
      edges,
      startingLevel: 'system',
      sourceMap,
      refPositions: {},
      groups,
      flows: []
    }
    return validationWarnings.length > 0 ? { ...parsed, validationWarnings } : parsed
  }
  const nodes = Array.isArray(root.nodes) ? root.nodes.map(normalizeNode) : []
  const seenEdgeIds = new Set<string>()
  const edges = (Array.isArray(root.edges) ? root.edges : []).filter((edge): edge is C4Edge => {
    if (!isRecord(edge) || typeof edge.id !== 'string') {
      return false
    }
    if (seenEdgeIds.has(edge.id)) {
      return false
    }
    seenEdgeIds.add(edge.id)
    return true
  })
  const flows = (
    Array.isArray(root.flows) ? root.flows : Array.isArray(root.scenarios) ? root.scenarios : []
  ).map((flow): Flow => {
    const record = isRecord(flow) ? flow : {}
    const steps = Array.isArray(record.steps) ? record.steps.map(normalizeFlowStep) : []
    const transitions = Array.isArray(record.transitions)
      ? (record.transitions as FlowTransition[])
      : []
    return {
      ...(record as Partial<Flow>),
      id: typeof record.id === 'string' ? record.id : globalThis.crypto.randomUUID(),
      name: typeof record.name === 'string' ? record.name : 'Flow',
      steps: migrateFlowTransitions(steps, transitions),
      transitions: undefined
    }
  })
  const nodeIds = new Set(nodes.map((node) => node.id))
  const validSourceKeys = new Set([...nodeIds, ...flows.map((flow) => flow.id)])
  const groups = normalizeGroups(root.groups, nodeIds)
  const sourceMap = normalizeSourceMap(root.sourceMap, validSourceKeys)
  const validationWarnings = collectMentionWarnings({ nodes, flows })

  const parsed: C4ModelData = {
    nodes,
    edges,
    startingLevel:
      root.startingLevel === 'container' || root.startingLevel === 'component'
        ? root.startingLevel
        : 'system',
    sourceMap,
    projectPath: typeof root.projectPath === 'string' ? root.projectPath : undefined,
    refPositions: isRecord(root.refPositions)
      ? (root.refPositions as C4ModelData['refPositions'])
      : {},
    groups,
    flows
  }
  return validationWarnings.length > 0 ? { ...parsed, validationWarnings } : parsed
}

export function serializeModelData(model: C4ModelData): string {
  const { validationWarnings: _validationWarnings, ...serializable } = model
  return JSON.stringify(serializable, null, 2)
}
