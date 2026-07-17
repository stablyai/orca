import { z } from 'zod'

export const WorktreeServicesStatusSchema = z.enum([
  'provisioning',
  'ready',
  'create_failed',
  'destroy_failed'
])
export type WorktreeServicesStatus = z.infer<typeof WorktreeServicesStatusSchema>

export const WorktreeServicesRecordSchema = z.object({
  worktreeId: z.string().min(1),
  repoId: z.string().min(1),
  slot: z.number().int().nonnegative(),
  slug: z.string().min(1),
  serviceIds: z.array(z.string().min(1)),
  env: z.record(z.string(), z.string()),
  status: WorktreeServicesStatusSchema,
  error: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
})
export type WorktreeServicesRecord = z.infer<typeof WorktreeServicesRecordSchema>

export const WorktreeServicesStoreSchema = z.object({
  version: z.literal(1),
  records: z.array(WorktreeServicesRecordSchema)
})
export type WorktreeServicesStore = z.infer<typeof WorktreeServicesStoreSchema>

// Live (non-persisted) runtime state of one provisioned service, probed on demand
// via the recipe's optional `status` command.
export type WorktreeServiceRunState = 'running' | 'stopped' | 'unknown'
export type WorktreeServiceRuntimeState = {
  serviceId: string
  name: string
  runState: WorktreeServiceRunState
  canStart: boolean
  canStop: boolean
}
