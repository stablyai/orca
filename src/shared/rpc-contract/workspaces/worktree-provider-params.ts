import * as z from 'zod'
import { OptionalExecutionHostId, WorktreeSelector } from './worktree-params'
import { OptionalString } from '../rpc-param-primitives'

export const WorktreeAcquire = z.object({
  repo: z.string().min(1),
  provider: z.string().min(1).max(64),
  profile: OptionalString
})

export const WorktreeRelease = WorktreeSelector.extend({
  hostId: OptionalExecutionHostId,
  force: z.boolean().optional(),
  forget: z.boolean().optional()
})

export const WorktreeProviderList = z.object({
  repo: z.string().min(1)
})

export const WorktreeProviderTrust = z.object({
  repo: z.string().min(1),
  expectedConfigHash: z.string().min(1).max(128)
})
