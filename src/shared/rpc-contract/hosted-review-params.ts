import { z } from 'zod'
import { requiredString } from './rpc-param-primitives'
import { OptionalGitAdmissionTier } from './git-admission-tier-params'

export const HostedReviewForBranch = z.object({
  repo: requiredString('Missing repo selector'),
  branch: requiredString('Missing branch'),
  admissionTier: OptionalGitAdmissionTier,
  currentHeadOid: z.string().nullable().optional(),
  // Only the caller's selected worktree; the host caps how many earn the fast tier.
  active: z.boolean().optional(),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  fallbackGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedAzureDevOpsPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

export const HostedReviewCreationEligibility = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: z.string().min(1, 'Missing worktree selector').optional(),
  branch: requiredString('Missing branch'),
  base: z.string().nullable().optional(),
  hasUncommittedChanges: z.boolean().optional(),
  hasUpstream: z.boolean().optional(),
  ahead: z.number().int().nonnegative().optional(),
  behind: z.number().int().nonnegative().optional(),
  linkedGitHubPR: z.number().int().positive().nullable().optional(),
  fallbackGitHubPR: z.number().int().positive().nullable().optional(),
  linkedGitLabMR: z.number().int().positive().nullable().optional(),
  linkedBitbucketPR: z.number().int().positive().nullable().optional(),
  linkedAzureDevOpsPR: z.number().int().positive().nullable().optional(),
  linkedGiteaPR: z.number().int().positive().nullable().optional()
})

export const HostedReviewCreate = z.object({
  repo: requiredString('Missing repo selector'),
  worktree: z.string().min(1, 'Missing worktree selector').optional(),
  // Open on purpose: the provider token is the host's own, and a client repeats back what a
  // newer host named in its eligibility reply. A closed enum rejects that create outright, so the
  // client would have to narrow to 'unsupported' before sending and make the host refuse its own
  // provider. The handler answers `unsupported_provider` for a token this build cannot create with.
  provider: z.string(),
  base: requiredString('Missing base branch'),
  head: z.string().optional(),
  title: requiredString('Missing title'),
  body: z.string().optional(),
  draft: z.boolean().optional(),
  useTemplate: z.boolean().optional()
})
