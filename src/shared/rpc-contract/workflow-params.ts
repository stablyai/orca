import { z } from 'zod'

const Id = z.string().min(1).max(128)

export const WorkflowPresetIdParams = z.object({ id: Id })

/** The preset is re-validated by the handler against the canonical schema; this only bounds size. */
export const WorkflowPresetSaveParams = z.object({ preset: z.unknown() })

export const WorkflowValidateParams = z.object({
  definition: z.unknown(),
  worktreeSelector: z.string().min(1).max(512).optional()
})

export const WorkflowRunStartParams = z.object({
  presetId: Id,
  objective: z.string().max(20_000),
  /** An Orca worktree selector such as id:<worktreeId>; the coordinator terminal opens there. */
  worktreeSelector: z.string().min(1).max(512),
  worktreeLabel: z.string().max(256),
  /** The editor's current preset, sent whole so a remote host runs exactly what was designed. */
  preset: z.unknown().optional()
})

export const WorkflowRunListParams = z.object({ presetId: Id.optional() })

export const WorkflowRunGetParams = z.object({
  id: Id,
  /** Return only events after this sequence number, so live views fetch deltas. */
  afterSeq: z.number().int().min(-1).optional()
})

export const WorkflowRunIdParams = z.object({ id: Id })

export const WorkflowTaskRetryParams = z.object({ runId: Id, taskKey: z.string().min(1).max(200) })

export const WorkflowApprovalResolveParams = z.object({
  runId: Id,
  taskKey: z.string().min(1).max(200),
  resolution: z.enum(['approved', 'rejected'])
})

export const WorkflowMessageReleaseParams = z.object({
  runId: Id,
  messageId: Id,
  decision: z.enum(['deliver', 'drop'])
})

export const WorkflowQuestionReplyParams = z.object({
  runId: Id,
  messageId: Id,
  body: z.string().min(1).max(20_000)
})
