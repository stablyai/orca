import * as z from 'zod'
import { PipelineStageEvidence } from './pipeline-stage-evidence'
import type { PipelineV2Run } from './v2/pipeline-v2-run-contracts'
import { PipelineV2TemplateSelection } from './v2/pipeline-v2-template-contracts'

const identifier = z.string().min(1).max(256)
const sourceRevision = z.string().regex(/^[a-f0-9]{40,64}$/)
const boundedTask = z
  .string()
  .min(1)
  .max(12000)
  .refine(
    (value) => JSON.stringify(value).length <= 12000,
    'Task exceeds serialized context budget'
  )
export const PipelineStage = z.enum(['plan', 'implement', 'checks', 'docs', 'review', 'fix'])
export const PipelineRole = z
  .strictObject({
    agent: z.string().min(1).max(64),
    model: z.string().min(1).max(128).optional(),
    effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).optional()
  })
  .refine((role) => !role.effort || Boolean(role.model), 'effort requires model')
export const PipelineProfile = z.strictObject({
  id: identifier,
  version: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  roles: z.strictObject({ primary: PipelineRole, reviewer: PipelineRole }),
  checks: z.array(identifier).min(1).max(16),
  maxFixCycles: z.number().int().min(0).max(2)
})
export const PipelineCheck = z.strictObject({
  id: identifier,
  program: z.string().min(1).max(4096),
  args: z.array(z.string().max(4096)).max(64),
  timeoutMs: z.number().int().min(100).max(600000)
})
export const PipelineSelection = z.strictObject({
  id: identifier,
  version: z.string().min(1).max(64),
  digest: z.string().regex(/^[a-f0-9]{64}$/)
})
export const PipelineStart = z.strictObject({
  profile: z.union([PipelineSelection, PipelineV2TemplateSelection]),
  expectedRuntimeId: identifier.optional(),
  task: boundedTask
})
export const PipelineDefinitionSnapshot = z.strictObject({
  profile: PipelineProfile,
  provider: z.strictObject({ pluginKey: identifier, fingerprint: identifier }),
  checkSnapshot: z.array(PipelineCheck).min(1).max(16)
})
export const PipelineWorkspace = z.strictObject({
  id: identifier,
  instanceId: identifier,
  hostId: z.literal('local'),
  projectId: identifier,
  path: z.string().min(1).max(4096)
})
export const PipelineCreate = z.strictObject({
  requestId: identifier,
  workspace: PipelineWorkspace,
  profile: PipelineProfile,
  provider: z.strictObject({ pluginKey: identifier, fingerprint: identifier }).optional(),
  checkSnapshot: z.array(PipelineCheck).max(16).default([]),
  waitForSetup: z.boolean().default(false),
  baseCommit: sourceRevision.optional(),
  task: boundedTask
})
export const PipelineCommand = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('dispatch'),
    dispatchId: identifier,
    sessionId: identifier,
    commit: sourceRevision.optional()
  }),
  z.strictObject({
    kind: z.literal('submit'),
    dispatchId: identifier,
    inputRevision: z.number().int().min(0),
    sourceRevision,
    body: z.string().min(1).max(12000),
    evidence: PipelineStageEvidence.optional(),
    verdict: z.enum(['pass', 'changes_requested', 'blocked'])
  }),
  z.strictObject({ kind: z.literal('pause'), reason: z.string().min(1).max(500).optional() }),
  z.strictObject({ kind: z.literal('resume') }),
  z.strictObject({ kind: z.literal('revalidate') }),
  z.strictObject({ kind: z.literal('recheck') }),
  z.strictObject({ kind: z.literal('wait_owner'), reason: z.string().min(1).max(500) }),
  z.strictObject({ kind: z.literal('setup_wait'), terminalHandle: identifier.optional() }),
  z.strictObject({ kind: z.literal('setup_ready') }),
  z.strictObject({ kind: z.literal('interrupted'), dispatchId: identifier }),
  z.strictObject({ kind: z.literal('uncertain'), reason: z.string().min(1).max(500) })
])
export const PipelineMutation = z.strictObject({
  requestId: identifier,
  expectedRevision: z.number().int().min(0),
  command: PipelineCommand
})

export type PipelineProfile = z.infer<typeof PipelineProfile>
export type PipelineSelection = z.infer<typeof PipelineSelection>
export type PipelineCheck = z.infer<typeof PipelineCheck>
export type PipelineWorkspace = z.infer<typeof PipelineWorkspace>
export type PipelineCommand = z.infer<typeof PipelineCommand>
export type PipelineStage = z.infer<typeof PipelineStage>
export type PipelineArtifact = {
  stage: PipelineStage
  attempt: number
  sourceRevision: string
  body: string
  dispatchId: string
  sessionId: string
  verdict: 'pass' | 'changes_requested' | 'blocked'
  evidence?: PipelineStageEvidence
  commit?: string
}
export type PipelineRun = {
  id: string
  workspace: PipelineWorkspace
  profile: PipelineProfile
  definitionDigest: string
  provider?: { pluginKey: string; fingerprint: string }
  checkSnapshot: PipelineCheck[]
  baseCommit?: string
  task: string
  revision: number
  state:
    | 'running'
    | 'waiting_setup'
    | 'paused'
    | 'waiting_owner'
    | 'reconciliation_required'
    | 'ready_for_review'
    | 'failed'
  stage: PipelineStage
  fixCycles: number
  primarySessionId?: string
  checkedRevision?: string
  reviewCommit?: string
  afterChecks?: 'docs' | 'review'
  reason?: string
  setupHold?: { terminalHandle?: string }
  active?: { dispatchId: string; sessionId: string; inputRevision: number }
  artifacts: PipelineArtifact[]
}

export type PipelineStoredRun = PipelineRun | PipelineV2Run
