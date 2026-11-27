import { z } from 'zod'
import { RepoSelector, RepoWithGitHubTarget, SlugRepo } from './github-repo-target-params'
import { requiredString } from '../rpc-param-primitives'
import { IssueUpdate } from './github-issue-update-params'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'

export const Issue = lazyZodSchema(() =>
  RepoWithGitHubTarget.extend({ number: z.number().int().positive() })
)

export const CreateIssue = lazyZodSchema(() =>
  RepoSelector.extend({
    title: requiredString('Missing title'),
    body: z.string(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional()
  })
)

export const UpdateIssue = lazyZodSchema(() =>
  RepoSelector.extend({
    ownerRepo: SlugRepo.optional(),
    number: z.number().int().positive(),
    updates: IssueUpdate
  })
)

export const IssueComment = lazyZodSchema(() =>
  RepoSelector.extend({
    number: z.number().int().positive(),
    body: requiredString('Comment body required'),
    type: z.enum(['issue', 'pr']).optional(),
    prRepo: SlugRepo.nullable().optional()
  })
)
