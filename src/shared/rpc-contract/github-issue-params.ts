import { z } from 'zod'
import { RepoSelector, SlugRepo } from './github-repo-target-params'
import { requiredString } from './rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'

export const Issue = RepoSelector.extend({
  number: z.number().int().positive()
})

export const CreateIssue = RepoSelector.extend({
  title: requiredString('Missing title'),
  body: z.string(),
  labels: z.array(z.string()).optional(),
  assignees: z.array(z.string()).optional()
})

export const UpdateIssue = RepoSelector.extend({
  number: z.number().int().positive(),
  updates: IssueUpdate
})

export const IssueComment = RepoSelector.extend({
  number: z.number().int().positive(),
  body: requiredString('Comment body required'),
  type: z.enum(['issue', 'pr']).optional(),
  prRepo: SlugRepo.nullable().optional()
})
