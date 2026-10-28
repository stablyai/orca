import { z } from 'zod'

const ExactPath = z.string().min(1).max(32768)
export const ConditionalRemovalPhysicalIdentity = z
  .object({
    path: ExactPath,
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/)
  })
  .strict()

export const ConditionalWorktreeRemoval = z
  .object({
    requestId: z.string().uuid(),
    expected: z
      .object({
        worktreeId: z.string().min(1).max(32768),
        identityKey: z.string().min(1).max(2048),
        instanceId: z.string().min(1).max(1024),
        executionHostId: z.string().min(1).max(1024),
        repoId: z.string().min(1).max(1024),
        branch: z.string().startsWith('refs/heads/').max(1024),
        head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
        checkout: ConditionalRemovalPhysicalIdentity,
        commonGitDirectory: ConditionalRemovalPhysicalIdentity,
        adminDirectory: ConditionalRemovalPhysicalIdentity
      })
      .strict()
  })
  .strict()

export type ConditionalWorktreeRemovalRequest = z.infer<typeof ConditionalWorktreeRemoval>
export type ConditionalRemovalExpected = ConditionalWorktreeRemovalRequest['expected']
export type ConditionalRemovalRefusal =
  | 'unsupported'
  | 'busy'
  | 'identity_changed'
  | 'session_live'
  | 'session_unknown'
  | 'git_not_clean'
  | 'git_operation_pending'
  | 'retention_conflict'
  | 'outcome_unknown'
export type ConditionalWorktreeRemovalResult =
  | { status: 'refused'; reason: ConditionalRemovalRefusal; detail: string }
  | {
      status: 'removed'
      requestId: string
      expected: ConditionalRemovalExpected
      retainedRef: string
    }
