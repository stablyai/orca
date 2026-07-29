import { z } from 'zod'
import { EphemeralVmRecipeResultSchema } from './ephemeral-vm-recipes'

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

export type EphemeralVmRuntimeConnectionMode = z.infer<
  typeof EphemeralVmRuntimeConnectionModeSchema
>

const EphemeralVmRuntimeRecipeSchema = z
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

export const EphemeralVmRuntimeRecordSchema = z.object({
  id: z.string().min(1),
  recipeId: z.string().min(1),
  /** Immutable lifecycle commands used for this runtime even if its source
   * pack is updated, disabled, or removed later. */
  recipe: EphemeralVmRuntimeRecipeSchema.optional(),
  repoId: z.string().min(1).optional(),
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
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  recipeResult: EphemeralVmRecipeResultSchema
})

export type EphemeralVmRuntimeRecord = z.infer<typeof EphemeralVmRuntimeRecordSchema>

export const EphemeralVmRuntimeStoreSchema = z.object({
  version: z.literal(1),
  runtimes: z.array(EphemeralVmRuntimeRecordSchema)
})

export type EphemeralVmRuntimeStore = z.infer<typeof EphemeralVmRuntimeStoreSchema>
