import { z } from 'zod'
import { WORKTREE_CREATE_EXECUTION_HOSTS } from './worktree/create-timing-vocabulary'

// Counts and closed enums only: no repo names, branch names, paths or error text.
const memberCountBucketSchema = z.enum(['2', '3', '4-5', '6+'])

export function bucketMultiRepoMemberCount(count: number): z.infer<typeof memberCountBucketSchema> {
  if (count <= 2) {
    return '2'
  }
  if (count === 3) {
    return '3'
  }
  return count <= 5 ? '4-5' : '6+'
}

const memberCountSchema = z.number().int().min(0).max(12)

export const multiRepoWorkspaceCreatedSchema = z
  .object({
    member_count_bucket: memberCountBucketSchema,
    ready_count: memberCountSchema,
    failed_count: memberCountSchema,
    total_duration_ms: z.number().int().nonnegative().optional(),
    execution_host: z.enum(WORKTREE_CREATE_EXECUTION_HOSTS).optional()
  })
  .strict()

export const multiRepoWorkspaceRemovedSchema = z
  .object({
    member_count_bucket: memberCountBucketSchema,
    outcome: z.enum(['all', 'partial']),
    kept_dir: z.boolean()
  })
  .strict()

export const multiRepoMemberRetrySchema = z
  .object({
    result: z.enum(['ready', 'failed'])
  })
  .strict()
