import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { ACTIONS_STATUSES } from '../github/actions-types'

export const ActionsRunsQuery = z.object({
  page: z.number().int().min(1).max(20).optional(),
  workflowId: z.number().int().positive().optional(),
  branch: z.string().max(1024).optional(),
  status: z.enum(ACTIONS_STATUSES).optional(),
  noCache: z.boolean().optional()
})
export const ActionsWorkflowsQuery = z.object({
  page: z.number().int().min(1).max(10).optional(),
  noCache: z.boolean().optional()
})
export const ActionsDetailsQuery = z.object({
  repository: SlugRepo,
  runId: z.number().int().positive(),
  jobsPage: z.number().int().min(1).max(10).optional(),
  expectedAttempt: z.number().int().positive().optional(),
  noCache: z.boolean().optional()
})
export const ActionsRuns = RepoSelector.merge(ActionsRunsQuery)
export const ActionsWorkflows = RepoSelector.merge(ActionsWorkflowsQuery)
export const ActionsRunDetails = RepoSelector.merge(ActionsDetailsQuery)
