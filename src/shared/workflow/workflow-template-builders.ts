import {
  defaultWorkflowCommunicationPolicy,
  type WorkflowCommunicationEdge,
  type WorkflowCommunicationPolicy,
  type WorkflowPayloadKind
} from './workflow-communication-schema'
import type { WorkflowCondition } from './workflow-condition-schema'
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowAgentNodeKind,
  type WorkflowAgentProfile,
  type WorkflowExecutionDependency,
  type WorkflowNode,
  type WorkflowPolicies,
  type WorkflowPreset,
  type WorkflowWorktreeMode
} from './workflow-definition-schema'
import { layoutWorkflowDefinition } from './workflow-auto-layout'

export function defaultWorkflowPolicies(): WorkflowPolicies {
  return {
    sharedInstructions:
      'Stay inside your assigned scope. Report blockers instead of guessing. Never print credentials.',
    maxConcurrentAgents: 4,
    maxTotalMessages: 200,
    maxTotalPayloadBytes: 2_000_000,
    estimatedTokenBudget: null,
    maxRunDurationMs: null,
    failurePolicy: 'fail-fast'
  }
}

export type WorkflowAgentSeed = {
  role: string
  agent?: string
  instructions: string
  task?: string
  responsibilities?: string[]
  forbidden?: string[]
  outputs?: string[]
  success?: string[]
  jsonFields?: string[]
  worktree?: WorkflowWorktreeMode
  maxAttempts?: number
}

export function defaultWorkflowAgentProfile(seed: WorkflowAgentSeed): WorkflowAgentProfile {
  return {
    role: seed.role,
    description: '',
    responsibilities: seed.responsibilities ?? [],
    allowedActions: [],
    forbiddenActions: seed.forbidden ?? [],
    expectedOutputs: seed.outputs ?? [],
    successCriteria: seed.success ?? [],
    runtime: {
      agent: seed.agent ?? 'claude',
      model: null,
      effort: null,
      allowModelFallback: false
    },
    placement: { worktree: seed.worktree ?? 'current' },
    execution: { timeoutMs: null, maxAttempts: seed.maxAttempts ?? 1 },
    prompt: {
      roleInstructions: seed.instructions,
      taskTemplate: seed.task ?? 'Objective: {{objective}}',
      includeSharedInstructions: true,
      readOnlyContext: '',
      outputRequirements: '',
      outputFormat: seed.jsonFields ? 'json' : 'text',
      requiredOutputFields: seed.jsonFields ?? []
    },
    skills: [],
    tools: []
  }
}

export function agentNode(
  kind: WorkflowAgentNodeKind,
  id: string,
  label: string,
  seed: WorkflowAgentSeed
): WorkflowNode {
  const agent = defaultWorkflowAgentProfile(seed)
  // One branch per kind so each literal narrows its own union member.
  switch (kind) {
    case 'agent':
      return { id, label, kind, agent }
    case 'coordinator':
      return { id, label, kind, agent }
    case 'reviewer':
      return { id, label, kind, agent }
  }
}

export const startNode = (): WorkflowNode => ({ id: 'start', label: 'Start', kind: 'start' })
export const endNode = (): WorkflowNode => ({
  id: 'end',
  label: 'End',
  kind: 'end',
  aggregate: true
})
export const parallelNode = (id: string): WorkflowNode => ({
  id,
  label: 'Parallel',
  kind: 'parallel'
})
export const joinNode = (id: string): WorkflowNode => ({
  id,
  label: 'Join',
  kind: 'join',
  mode: 'all'
})

export function dependency(
  source: string,
  target: string,
  options: { label?: string; condition?: WorkflowCondition; loop?: number } = {}
): WorkflowExecutionDependency {
  return {
    id: `x-${source}-${target}${options.loop ? '-loop' : ''}`,
    source,
    target,
    label: options.label ?? '',
    condition: options.condition ?? null,
    loop: options.loop ? { maxIterations: options.loop } : null
  }
}

/** One dependency per consecutive pair: chain('a','b','c') is a→b, b→c. */
export function chain(...ids: string[]): WorkflowExecutionDependency[] {
  return ids.slice(1).map((id, index) => dependency(ids[index], id))
}

export function route(
  source: string,
  target: string,
  name: string,
  payload: WorkflowPayloadKind,
  overrides: Partial<WorkflowCommunicationPolicy> & { fields?: string[] } = {}
): WorkflowCommunicationEdge {
  const { fields, ...policyOverrides } = overrides
  const policy = { ...defaultWorkflowCommunicationPolicy(payload), ...policyOverrides }
  return {
    id: `c-${source}-${target}`,
    source,
    target,
    name,
    enabled: true,
    policy: { ...policy, payload: { ...policy.payload, fields: fields ?? [] } }
  }
}

export const VERDICT_APPROVED: WorkflowCondition = {
  kind: 'field',
  path: 'verdict',
  op: 'equals',
  value: 'approved'
}

export const REVIEW_JSON_FIELDS = ['verdict', 'findings']

export function buildWorkflowTemplate(args: {
  id: string
  name: string
  description: string
  objective: string
  nodes: WorkflowNode[]
  dependencies: WorkflowExecutionDependency[]
  communication: WorkflowCommunicationEdge[]
  policies?: Partial<WorkflowPolicies>
}): WorkflowPreset {
  const definition = {
    nodes: args.nodes,
    dependencies: args.dependencies,
    communication: args.communication,
    policies: { ...defaultWorkflowPolicies(), ...args.policies }
  }
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: args.id,
    name: args.name,
    description: args.description,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    template: true,
    definition,
    layout: {
      viewport: { x: 40, y: 40, zoom: 0.85 },
      positions: layoutWorkflowDefinition(definition)
    },
    defaultRunSettings: { objective: args.objective }
  }
}
