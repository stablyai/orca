import { isGitHistoryRefName } from '../../git/history/git-history-revisions'
import { z } from 'zod'
import { lazyZodSchema } from '../../schema/lazy-zod-schema'
import { OptionalGitAdmissionTier } from './git-admission-tier-params'
import { CONFLICT_RESOLUTIONS } from '../../source-control/listing/source-control-entry-actions'

export const WorktreeSelector = lazyZodSchema(() =>
  z.object({
    worktree: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing worktree selector'))
  })
)

export const GitStatusParams = lazyZodSchema(() =>
  WorktreeSelector.extend({
    admissionTier: OptionalGitAdmissionTier,
    includeIgnored: z.boolean().optional(),
    includeLineStats: z.boolean().optional(),
    bypassEffectiveUpstreamNegativeCache: z.boolean().optional(),
    reuseLineStats: z.boolean().optional(),
    // Shape is re-validated host-side before it reaches a git argv.
    branchLineTotalMergeBase: z.string().optional()
  })
)

export const GitCheckIgnored = lazyZodSchema(() =>
  WorktreeSelector.extend({
    paths: z.array(z.string().min(1, 'Missing path')).max(2000)
  })
)

export const GitSubmoduleStatus = lazyZodSchema(() =>
  WorktreeSelector.extend({
    submodulePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(
        z
          .string()
          .min(1, 'Missing submodule path')
          // Why: never let a submodule path be parsed as a git flag (arg injection).
          .refine((value) => !value.startsWith('-'), 'Submodule path must not start with -')
      ),
    // The Source Control row selects HEAD→index versus index→worktree gitlink ranges.
    area: z.enum(['staged', 'unstaged', 'untracked']).optional()
  })
)

export const GitFilePath = lazyZodSchema(() =>
  WorktreeSelector.extend({
    filePath: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing file path'))
  })
)

export const GitResolveConflict = lazyZodSchema(() =>
  GitFilePath.extend({
    resolution: z.enum(CONFLICT_RESOLUTIONS)
  })
)

export const GitDiff = lazyZodSchema(() =>
  GitFilePath.extend({
    staged: z.boolean(),
    compareAgainstHead: z.boolean().optional(),
    oldPath: z.string().optional()
  })
)

// Hosts that predate knownHeadOid ignore it and resend the full blame.
export const GitBlame = lazyZodSchema(() =>
  GitFilePath.extend({
    knownHeadOid: z.string().optional()
  })
)

export const GitBranchCompare = lazyZodSchema(() =>
  WorktreeSelector.extend({
    admissionTier: OptionalGitAdmissionTier,
    baseRef: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(
        z
          .string()
          .min(1, 'Missing base ref')
          .refine((value) => !value.startsWith('-'), 'Base ref must not start with -')
      )
  })
)

export const FullGitObjectId = lazyZodSchema(() =>
  z.string().regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/, 'Expected a full git object id')
)

export const GitCommitCompare = lazyZodSchema(() =>
  WorktreeSelector.extend({
    commitId: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(FullGitObjectId)
  })
)

export const GitSequencer = lazyZodSchema(() =>
  WorktreeSelector.extend({
    operation: z.enum(['cherry-pick', 'revert'])
  })
)

export const GitCreateBranch = lazyZodSchema(() =>
  WorktreeSelector.extend({
    name: z.string().min(1),
    startPoint: FullGitObjectId
  })
)

export const GitCommitAction = lazyZodSchema(() =>
  WorktreeSelector.extend({ commitId: FullGitObjectId })
)

export const GitHistoryRefName = lazyZodSchema(() =>
  z.string().refine(isGitHistoryRefName, 'Expected full branch or tag ref names')
)

export const GitRefs = lazyZodSchema(() =>
  WorktreeSelector.extend({ query: z.string().max(1000).optional() })
)

export const GitHistory = lazyZodSchema(() =>
  WorktreeSelector.extend({
    limit: z.number().int().min(1).max(200).optional(),
    baseRef: z.string().nullable().optional(),
    branchOnly: z.boolean().optional(),
    branchListOnly: z.boolean().optional(),
    refs: z
      .union([z.literal('head'), z.literal('all'), z.array(GitHistoryRefName).max(1000)])
      .optional(),
    historyToken: z.string().max(100).optional(),
    skip: z.number().int().min(0).optional()
  })
)

export const GitBranchDiff = lazyZodSchema(() =>
  GitFilePath.extend({
    compare: z.object({
      baseRef: z.string().optional(),
      baseOid: FullGitObjectId.optional(),
      headOid: FullGitObjectId,
      mergeBase: FullGitObjectId
    }),
    oldPath: z.string().optional()
  })
)

export const GitCommitDiff = lazyZodSchema(() =>
  GitFilePath.extend({
    commitOid: FullGitObjectId,
    parentOid: FullGitObjectId.nullable().optional(),
    oldPath: z.string().optional()
  })
)

export const GitCommit = lazyZodSchema(() =>
  WorktreeSelector.extend({
    message: z
      .unknown()
      .transform((v) => (typeof v === 'string' ? v : ''))
      .pipe(z.string().min(1, 'Missing commit message'))
  })
)
