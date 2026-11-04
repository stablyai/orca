import {
  WORKFLOW_SCHEMA_VERSION,
  isWorkflowAgentNode,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowPreset
} from '../../../../shared/workflow/workflow-definition-schema'
import {
  agentNode,
  defaultWorkflowPolicies,
  dependency,
  route
} from '../../../../shared/workflow/workflow-template-builders'
import { layoutWorkflowDefinition } from '../../../../shared/workflow/workflow-auto-layout'
import { translate } from '@/i18n/i18n'

export type WorkflowEdgeKind = 'dependency' | 'communication'

export type WorkflowClipboard = {
  nodes: WorkflowNode[]
  positions: Record<string, { x: number; y: number }>
}

const NODE_LABELS: Record<WorkflowNodeKind, string> = {
  agent: 'Agent',
  coordinator: 'Coordinator',
  reviewer: 'Reviewer',
  start: 'Start',
  end: 'End',
  decision: 'Decision',
  approval: 'Approval',
  parallel: 'Parallel',
  join: 'Join'
}

export function workflowNodeKindLabel(kind: WorkflowNodeKind): string {
  return NODE_LABELS[kind]
}

/** Ids stay stable once minted; a copy always gets a fresh one. */
export function uniqueWorkflowId(base: string, taken: ReadonlySet<string>): string {
  const stem =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  if (!taken.has(stem)) {
    return stem
  }
  for (let index = 2; ; index += 1) {
    const candidate = `${stem}-${index}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
}

function takenIds(preset: WorkflowPreset): Set<string> {
  const { nodes, dependencies, communication } = preset.definition
  return new Set([...nodes, ...dependencies, ...communication].map((entry) => entry.id))
}

export function createWorkflowNode(kind: WorkflowNodeKind, id: string): WorkflowNode {
  const label = NODE_LABELS[kind]
  switch (kind) {
    case 'agent':
    case 'coordinator':
    case 'reviewer':
      return agentNode(kind, id, label, {
        role: label,
        instructions: `You are the ${label.toLowerCase()}.`,
        ...(kind === 'reviewer' ? { jsonFields: ['verdict', 'findings'] } : {})
      })
    case 'end':
      return { id, label, kind, aggregate: true }
    case 'decision':
      return { id, label, kind, subjectNodeId: null }
    case 'approval':
      return { id, label, kind, question: 'Approve this step?' }
    case 'join':
      return { id, label, kind, mode: 'all' }
    case 'start':
    case 'parallel':
      return { id, label, kind }
  }
}

export function addWorkflowNode(
  preset: WorkflowPreset,
  kind: WorkflowNodeKind,
  position: { x: number; y: number }
): string {
  const id = uniqueWorkflowId(kind, takenIds(preset))
  preset.definition.nodes.push(createWorkflowNode(kind, id))
  preset.layout.positions[id] = position
  return id
}

export function removeWorkflowElements(
  preset: WorkflowPreset,
  ids: {
    nodes?: readonly string[]
    dependencies?: readonly string[]
    communication?: readonly string[]
  }
): void {
  const nodes = new Set(ids.nodes ?? [])
  const dependencies = new Set(ids.dependencies ?? [])
  const communication = new Set(ids.communication ?? [])
  const definition = preset.definition
  definition.nodes = definition.nodes.filter((node) => !nodes.has(node.id))
  definition.dependencies = definition.dependencies.filter(
    (edge) => !dependencies.has(edge.id) && !nodes.has(edge.source) && !nodes.has(edge.target)
  )
  definition.communication = definition.communication.filter(
    (edge) => !communication.has(edge.id) && !nodes.has(edge.source) && !nodes.has(edge.target)
  )
  for (const node of definition.nodes) {
    if (node.kind === 'decision' && node.subjectNodeId && nodes.has(node.subjectNodeId)) {
      node.subjectNodeId = null
    }
  }
  for (const id of nodes) {
    delete preset.layout.positions[id]
  }
}

/** Refuse connections that can never be valid; graph-level problems are left to validation. */
export function connectWorkflowNodes(
  preset: WorkflowPreset,
  kind: WorkflowEdgeKind,
  source: string,
  target: string
): { id: string } | { error: string } {
  const definition = preset.definition
  const from = definition.nodes.find((node) => node.id === source)
  const to = definition.nodes.find((node) => node.id === target)
  if (!from || !to || source === target) {
    return {
      error: translate(
        'auto.components.workflows.workflow.editor.mutations.881ec4b77e',
        'Connect two different nodes.'
      )
    }
  }
  if (kind === 'communication') {
    if (!isWorkflowAgentNode(from) || !isWorkflowAgentNode(to)) {
      return {
        error: translate(
          'auto.components.workflows.workflow.editor.mutations.42a817ffbe',
          'Communication routes connect agents only.'
        )
      }
    }
    if (definition.communication.some((edge) => edge.source === source && edge.target === target)) {
      return {
        error: translate(
          'auto.components.workflows.workflow.editor.mutations.c12b90638a',
          'That route already exists.'
        )
      }
    }
    const edge = route(source, target, `${from.label} → ${to.label}`, 'summary')
    edge.id = uniqueWorkflowId(edge.id, takenIds(preset))
    definition.communication.push(edge)
    return { id: edge.id }
  }
  if (to.kind === 'start' || from.kind === 'end') {
    return {
      error: translate(
        'auto.components.workflows.workflow.editor.mutations.3a839e1c90',
        'Start has no inputs and End has no outputs.'
      )
    }
  }
  if (definition.dependencies.some((edge) => edge.source === source && edge.target === target)) {
    return {
      error: translate(
        'auto.components.workflows.workflow.editor.mutations.eabd8b2bfd',
        'That dependency already exists.'
      )
    }
  }
  const edge = dependency(source, target)
  edge.id = uniqueWorkflowId(edge.id, takenIds(preset))
  definition.dependencies.push(edge)
  return { id: edge.id }
}

export function copyWorkflowNodes(
  preset: WorkflowPreset,
  ids: readonly string[]
): WorkflowClipboard {
  const wanted = new Set(ids)
  return {
    nodes: structuredClone(preset.definition.nodes.filter((node) => wanted.has(node.id))),
    positions: Object.fromEntries(
      [...wanted].flatMap((id) =>
        preset.layout.positions[id] ? [[id, preset.layout.positions[id]]] : []
      )
    )
  }
}

/** Paste copies with fresh ids, keeping the dependencies and routes among the copied nodes. */
export function pasteWorkflowNodes(
  preset: WorkflowPreset,
  clipboard: WorkflowClipboard,
  sourceDefinition: WorkflowPreset['definition'] | null,
  offset = 40
): string[] {
  const taken = takenIds(preset)
  const renamed = new Map<string, string>()
  for (const node of clipboard.nodes) {
    const id = uniqueWorkflowId(`${node.id}-copy`, taken)
    taken.add(id)
    renamed.set(node.id, id)
    preset.definition.nodes.push({
      ...structuredClone(node),
      id,
      label: `${node.label} copy`.slice(0, 80)
    })
    const position = clipboard.positions[node.id] ?? { x: 0, y: 0 }
    preset.layout.positions[id] = { x: position.x + offset, y: position.y + offset }
  }
  for (const edge of sourceDefinition?.dependencies ?? []) {
    const source = renamed.get(edge.source)
    const target = renamed.get(edge.target)
    if (source && target) {
      const id = uniqueWorkflowId(`${edge.id}-copy`, taken)
      taken.add(id)
      preset.definition.dependencies.push({ ...structuredClone(edge), id, source, target })
    }
  }
  for (const edge of sourceDefinition?.communication ?? []) {
    const source = renamed.get(edge.source)
    const target = renamed.get(edge.target)
    if (source && target) {
      const id = uniqueWorkflowId(`${edge.id}-copy`, taken)
      taken.add(id)
      preset.definition.communication.push({ ...structuredClone(edge), id, source, target })
    }
  }
  return [...renamed.values()]
}

export function autoLayoutWorkflow(preset: WorkflowPreset): void {
  preset.layout.positions = layoutWorkflowDefinition(preset.definition)
}

export function createBlankWorkflowPreset(id: string, now: string): WorkflowPreset {
  const definition = {
    nodes: [
      createWorkflowNode('start', 'start'),
      createWorkflowNode('agent', 'agent'),
      createWorkflowNode('end', 'end')
    ],
    dependencies: [dependency('start', 'agent'), dependency('agent', 'end')],
    communication: [],
    policies: defaultWorkflowPolicies()
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id,
    name: 'Untitled workflow',
    description: '',
    createdAt: now,
    updatedAt: now,
    template: false,
    definition,
    layout: {
      viewport: { x: 80, y: 80, zoom: 1 },
      positions: layoutWorkflowDefinition(definition)
    },
    defaultRunSettings: { objective: '' }
  }
}
