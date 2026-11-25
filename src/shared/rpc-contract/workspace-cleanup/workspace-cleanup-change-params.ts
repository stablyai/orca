import { z } from 'zod'
import {
  RepoWorkspaceCleanupPolicyParam,
  WorkspaceCleanupRulesParam
} from './workspace-cleanup-policy-params'

export const WorkspaceCleanupPolicyStateParam = z
  .object({
    repoId: z.string().min(1).nullable(),
    rules: WorkspaceCleanupRulesParam,
    projects: z
      .array(
        z
          .object({
            id: z.string().min(1),
            hostId: z.string().min(1),
            policy: RepoWorkspaceCleanupPolicyParam
          })
          .strict()
      )
      .max(100_000)
  })
  .strict()
export const WorkspaceCleanupGuardParam = z
  .object({
    id: z.string().uuid(),
    expiresAt: z.number().finite(),
    expected: WorkspaceCleanupPolicyStateParam,
    requireReservation: z.literal(true).optional()
  })
  .strict()
export const WorkspaceCleanupPolicyReadParams = z
  .object({ repoId: z.string().min(1).nullable() })
  .strict()
const WorkspaceCleanupProposalParam = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('global'), rules: WorkspaceCleanupRulesParam }).strict(),
  z
    .object({
      scope: z.literal('project'),
      repoId: z.string().min(1),
      policy: RepoWorkspaceCleanupPolicyParam
    })
    .strict()
])
export const WorkspaceCleanupChangeParams = z
  .object({
    change: WorkspaceCleanupProposalParam,
    expected: WorkspaceCleanupPolicyStateParam,
    fresh: z.boolean().optional()
  })
  .strict()
export const WorkspaceCleanupSettleParams = z
  .object({ id: z.string().uuid(), expiresAt: z.number().finite() })
  .strict()
export const WorkspaceCleanupPinParams = z
  .object({
    worktreeId: z.string().min(1),
    instanceId: z.string().min(1)
  })
  .strict()

export const WorkspaceCleanupInspectKeptParams = z
  .object({ rows: z.array(WorkspaceCleanupPinParams).max(100_000) })
  .strict()

export const WorkspaceCleanupPinBatchParams = WorkspaceCleanupInspectKeptParams.refine(
  ({ rows }) => new Set(rows.map((row) => row.worktreeId)).size === rows.length
)
