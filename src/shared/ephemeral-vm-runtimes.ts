import { z } from 'zod'
import {
  EphemeralVmRecipeConnectionResultSchema,
  EphemeralVmRecipeLegacyResultSchema,
  EphemeralVmRecipeResultSchema
} from './ephemeral-vm-recipes'
import type { EphemeralVmFailure } from './ephemeral-vm-failure-copy'

export const EphemeralVmRuntimeStatusSchema = z.enum([
  'provisioning',
  'running',
  'suspended',
  'suspend_failed',
  'resume_failed',
  'failed',
  'cleanup_pending',
  'cleanup_failed',
  'cleaned'
])

export type EphemeralVmRuntimeStatus = z.infer<typeof EphemeralVmRuntimeStatusSchema>

export const EphemeralVmCleanupStatusSchema = z.enum([
  'not_started',
  'disabled',
  'running',
  'succeeded',
  'failed'
])

export type EphemeralVmCleanupStatus = z.infer<typeof EphemeralVmCleanupStatusSchema>

export const EphemeralVmRuntimeConnectionModeSchema = z.enum(['orca-server', 'ssh'])

const EphemeralVmRuntimeRecipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    create: z.string().min(1),
    checkoutMode: z.enum(['orca-worktree', 'provisioned-root']).optional(),
    description: z.string().min(1).optional(),
    suspend: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    destroy: z.string().min(1).optional(),
    destroyDisabled: z.boolean().optional()
  })
  .strict()

export const EphemeralVmRuntimeRecordSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  /** Snapshot lifecycle commands so later pack updates/disabling/removal cannot change an existing runtime’s cleanup. */
  recipe: EphemeralVmRuntimeRecipeSchema.optional(),
  repoId: z.string().min(1).optional(),
  /** Repo checkout the lifecycle commands ran from, so destroy still works if `repoId` stops resolving. */
  repoPath: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  workspaceId: z.string().min(1).optional(),
  workspaceName: z.string().min(1).optional(),
  connectionMode: EphemeralVmRuntimeConnectionModeSchema.optional(),
  runtimeEnvironmentId: z.string().min(1).optional(),
  sshTargetId: z.string().min(1).optional(),
  status: EphemeralVmRuntimeStatusSchema,
  cleanupStatus: EphemeralVmCleanupStatusSchema,
  cleanupDisabled: z.boolean().optional(),
  cleanupLastAttemptAt: z.number().finite().optional(),
  cleanupLastError: z.string().min(1).optional(),
  /** Optional open code + params so the renderer can localize `cleanupLastError`; English stays authoritative. */
  cleanupLastErrorCode: z.string().min(1).optional(),
  cleanupLastErrorParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  /** Last suspend/resume failure (English + optional code/params); cleared when one succeeds. */
  lifecycleLastError: z.string().min(1).optional(),
  lifecycleLastErrorCode: z.string().min(1).optional(),
  lifecycleLastErrorParams: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  /** Absent only on write-ahead records persisted before `create` returned a result. */
  recipeResult: EphemeralVmRecipeResultSchema.optional()
})

export type EphemeralVmRuntimeRecord = z.infer<typeof EphemeralVmRuntimeRecordSchema>

export type EphemeralVmProvisionedRuntimeRecord = EphemeralVmRuntimeRecord & {
  recipeResult: NonNullable<EphemeralVmRuntimeRecord['recipeResult']>
}

export function hasEphemeralVmRecipeResult(
  runtime: EphemeralVmRuntimeRecord
): runtime is EphemeralVmProvisionedRuntimeRecord {
  return runtime.recipeResult !== undefined
}

export function requireEphemeralVmRecipeResult(
  runtime: EphemeralVmRuntimeRecord
): EphemeralVmProvisionedRuntimeRecord {
  if (!hasEphemeralVmRecipeResult(runtime)) {
    throw new Error(`Ephemeral VM runtime never finished provisioning: ${runtime.id}`)
  }
  return runtime
}

/** Fields `updateEphemeralVmRuntimeStatus` may change; undefined leaves a field as is. */
export type EphemeralVmRuntimeStatusPatch = {
  status?: EphemeralVmRuntimeStatus
  cleanupStatus?: EphemeralVmCleanupStatus
  cleanupLastAttemptAt?: number
  /** A string clears any stored code; null clears both. */
  cleanupLastError?: string | EphemeralVmFailure | null
  /** Suspend/resume failure; null clears it. */
  lifecycleLastError?: EphemeralVmFailure | null
  workspaceId?: string
  workspaceName?: string
  connectionMode?: EphemeralVmRuntimeRecord['connectionMode'] | null
  runtimeEnvironmentId?: string
  sshTargetId?: string | null
  recipeResult?: EphemeralVmRuntimeRecord['recipeResult']
  updatedAt?: number
}

/** Suspend/resume over IPC: failures come back as values so the code reaches the renderer catalog. */
export type EphemeralVmWorkspaceLifecycleResult =
  | { ok: true; runtime: EphemeralVmRuntimeRecord | null }
  | ({ ok: false } & EphemeralVmFailure)

export const EphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(EphemeralVmRuntimeRecordSchema)
})

export type EphemeralVmRuntimeStore = z.infer<typeof EphemeralVmRuntimeStoreSchema>

const RollbackEphemeralVmRuntimeRecipeSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    create: z.string().min(1),
    description: z.string().min(1).optional(),
    suspend: z.string().min(1).optional(),
    resume: z.string().min(1).optional(),
    destroy: z.string().min(1).optional(),
    destroyDisabled: z.boolean().optional()
  })
  .strict()

export const RollbackEphemeralVmRuntimeRecordSchema = EphemeralVmRuntimeRecordSchema.extend({
  recipe: RollbackEphemeralVmRuntimeRecipeSchema.optional(),
  recipeResult: z.union([
    EphemeralVmRecipeLegacyResultSchema,
    EphemeralVmRecipeConnectionResultSchema
  ])
})

export const RollbackEphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(RollbackEphemeralVmRuntimeRecordSchema)
})
