import type { GitWorktreeHostProcessIdentity } from './git-worktree-host-process-identity'

export type GitWorktreeHostLockClaim = Readonly<{
  path: string
  owner: GitWorktreeHostProcessIdentity & { token: string }
}>

export type GitWorktreeHostLockTestHooks = Readonly<{
  afterPendingClaimCreated?: () => Promise<void>
  afterClaimPublished?: (claim: GitWorktreeHostLockClaim) => Promise<void>
  beforeStaleClaimRemoved?: (claimPath: string) => Promise<void>
  beforeClaimRetired?: (claimPath: string) => Promise<void>
}>
