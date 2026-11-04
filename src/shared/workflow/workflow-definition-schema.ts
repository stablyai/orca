import { z } from 'zod'
import { WorkflowConditionSchema } from './workflow-condition-schema'
import { WorkflowCommunicationEdgeSchema } from './workflow-communication-schema'

export const WORKFLOW_SCHEMA_VERSION = 1

/** Stable ids are user-visible in exports and Orca task titles; keep them shell- and path-inert. */
export const WorkflowId = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, 'Use letters, digits, - or _')

const ShortText = z.string().max(200)
const LongText = z.string().max(20_000)
const TextList = z.array(z.string().max(500)).max(40)

export const WORKFLOW_AGENT_NODE_KINDS = ['agent', 'coordinator', 'reviewer'] as const
export const WORKFLOW_CONTROL_NODE_KINDS = [
  'start',
  'end',
  'decision',
  'approval',
  'parallel',
  'join'
] as const
export const WORKFLOW_NODE_KINDS = [
  ...WORKFLOW_AGENT_NODE_KINDS,
  ...WORKFLOW_CONTROL_NODE_KINDS
] as const

export type WorkflowNodeKind = (typeof WORKFLOW_NODE_KINDS)[number]
export type WorkflowAgentNodeKind = (typeof WORKFLOW_AGENT_NODE_KINDS)[number]

export const WORKFLOW_WORKTREE_MODES = ['current', 'new-child', 'new-top-level'] as const
export type WorkflowWorktreeMode = (typeof WORKFLOW_WORKTREE_MODES)[number]

export const WorkflowModelConfigurationSchema = z.object({
  /** An Orca TUI agent id (claude, codex, opencode...); availability is checked on the host. */
  agent: z.string().min(1).max(64),
  model: z.string().min(1).max(512).nullable(),
  effort: z.string().min(1).max(512).nullable(),
  /** Off by default: a refused model fails validation instead of silently running another. */
  allowModelFallback: z.boolean()
})
export type WorkflowModelConfiguration = z.infer<typeof WorkflowModelConfigurationSchema>

export const WorkflowPromptConfigurationSchema = z.object({
  roleInstructions: LongText,
  taskTemplate: LongText,
  includeSharedInstructions: z.boolean(),
  readOnlyContext: LongText,
  outputRequirements: LongText,
  /** json asks the worker for a WORKFLOW_RESULT object that conditions and payloads can read. */
  outputFormat: z.enum(['text', 'json']),
  requiredOutputFields: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).max(20)
})
export type WorkflowPromptConfiguration = z.infer<typeof WorkflowPromptConfigurationSchema>

export const WorkflowSkillAssignmentSchema = z.object({
  name: z.string().min(1).max(128),
  required: z.boolean()
})
export type WorkflowSkillAssignment = z.infer<typeof WorkflowSkillAssignmentSchema>

export const WORKFLOW_TOOLS = ['terminal', 'files', 'git', 'browser', 'mcp', 'tests'] as const
export type WorkflowTool = (typeof WORKFLOW_TOOLS)[number]

export const WorkflowToolAssignmentSchema = z.object({
  tool: z.enum(WORKFLOW_TOOLS),
  /** Declared intent only: Orca cannot sandbox a CLI agent's shell from a prompt. */
  mode: z.enum(['expected', 'avoid'])
})
export type WorkflowToolAssignment = z.infer<typeof WorkflowToolAssignmentSchema>

export const WorkflowAgentProfileSchema = z.object({
  role: ShortText,
  description: z.string().max(2_000),
  responsibilities: TextList,
  allowedActions: TextList,
  forbiddenActions: TextList,
  expectedOutputs: TextList,
  successCriteria: TextList,
  runtime: WorkflowModelConfigurationSchema,
  placement: z.object({ worktree: z.enum(WORKFLOW_WORKTREE_MODES) }),
  execution: z.object({
    timeoutMs: z.number().int().min(10_000).max(86_400_000).nullable(),
    maxAttempts: z.number().int().min(1).max(5)
  }),
  prompt: WorkflowPromptConfigurationSchema,
  skills: z.array(WorkflowSkillAssignmentSchema).max(32),
  tools: z.array(WorkflowToolAssignmentSchema).max(WORKFLOW_TOOLS.length)
})
export type WorkflowAgentProfile = z.infer<typeof WorkflowAgentProfileSchema>

const NodeBase = { id: WorkflowId, label: z.string().min(1).max(80) }

export const WorkflowNodeSchema = z.discriminatedUnion('kind', [
  z.object({ ...NodeBase, kind: z.literal('agent'), agent: WorkflowAgentProfileSchema }),
  z.object({ ...NodeBase, kind: z.literal('coordinator'), agent: WorkflowAgentProfileSchema }),
  z.object({ ...NodeBase, kind: z.literal('reviewer'), agent: WorkflowAgentProfileSchema }),
  z.object({ ...NodeBase, kind: z.literal('start') }),
  z.object({
    ...NodeBase,
    kind: z.literal('end'),
    /** Collect incoming results into the run's final output. */
    aggregate: z.boolean()
  }),
  z.object({
    ...NodeBase,
    kind: z.literal('decision'),
    /** The node whose result outgoing conditions read; null reads the single upstream node. */
    subjectNodeId: WorkflowId.nullable()
  }),
  z.object({ ...NodeBase, kind: z.literal('approval'), question: z.string().min(1).max(2_000) }),
  z.object({ ...NodeBase, kind: z.literal('parallel') }),
  z.object({ ...NodeBase, kind: z.literal('join'), mode: z.enum(['all', 'any']) })
])
export type WorkflowNode = z.infer<typeof WorkflowNodeSchema>
export type WorkflowAgentNode = Extract<WorkflowNode, { kind: WorkflowAgentNodeKind }>

export const WorkflowExecutionDependencySchema = z.object({
  id: WorkflowId,
  source: WorkflowId,
  target: WorkflowId,
  label: z.string().max(80),
  /** Null always fires (or is the decision fallback when no other condition matches). */
  condition: WorkflowConditionSchema.nullable(),
  /** Only a loop edge may point back upstream; it re-runs the region at most maxIterations times. */
  loop: z.object({ maxIterations: z.number().int().min(1).max(10) }).nullable()
})
export type WorkflowExecutionDependency = z.infer<typeof WorkflowExecutionDependencySchema>

export const WorkflowPoliciesSchema = z.object({
  sharedInstructions: LongText,
  maxConcurrentAgents: z.number().int().min(1).max(16),
  maxTotalMessages: z.number().int().min(1).max(10_000),
  maxTotalPayloadBytes: z.number().int().min(1_024).max(50_000_000),
  /** Estimated (bytes/4), never presented as provider-measured usage. */
  estimatedTokenBudget: z.number().int().min(100).max(50_000_000).nullable(),
  maxRunDurationMs: z
    .number()
    .int()
    .min(60_000)
    .max(7 * 86_400_000)
    .nullable(),
  failurePolicy: z.enum(['fail-fast', 'continue'])
})
export type WorkflowPolicies = z.infer<typeof WorkflowPoliciesSchema>

export const WorkflowDefinitionSchema = z.object({
  nodes: z.array(WorkflowNodeSchema).min(1).max(200),
  dependencies: z.array(WorkflowExecutionDependencySchema).max(800),
  communication: z.array(WorkflowCommunicationEdgeSchema).max(800),
  policies: WorkflowPoliciesSchema
})
export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>

/** Presentation only: nothing here reaches the controller. */
export const WorkflowLayoutSchema = z.object({
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number().min(0.05).max(4)
  }),
  positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() }))
})
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>

export const WorkflowPresetSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION),
  id: WorkflowId,
  name: z.string().min(1).max(120),
  description: z.string().max(2_000),
  createdAt: z.string().max(64),
  updatedAt: z.string().max(64),
  /** Templates are copied before editing; the shipped copy is never overwritten. */
  template: z.boolean(),
  definition: WorkflowDefinitionSchema,
  layout: WorkflowLayoutSchema,
  defaultRunSettings: z.object({ objective: z.string().max(20_000) })
})
export type WorkflowPreset = z.infer<typeof WorkflowPresetSchema>

export function isWorkflowAgentNode(node: WorkflowNode): node is WorkflowAgentNode {
  return node.kind === 'agent' || node.kind === 'coordinator' || node.kind === 'reviewer'
}
