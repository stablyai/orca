import type { WorktreeProviderConfig, WorktreeProviderWorkspace } from './worktree-provider-types'

function appendProfile(argv: readonly string[], profile: string | undefined): string[] {
  return profile ? [...argv, '--profile', profile] : [...argv]
}

/** Claim is invoked with the repo path and, when requested, the profile. */
export function buildWorktreeProviderClaimArgv(
  provider: WorktreeProviderConfig,
  args: { repoPath: string; profile?: string }
): string[] {
  return appendProfile([...provider.claim, '--repo', args.repoPath], args.profile)
}

/** Release takes the provider's path as its first positional argument, then the lease metadata. */
export function buildWorktreeProviderReleaseArgv(
  provider: WorktreeProviderConfig,
  args: {
    repoPath: string
    worktreePath?: string
    leaseId?: string
    handle?: Record<string, unknown>
    force?: boolean
  }
): string[] {
  const argv = [
    ...provider.release,
    ...(args.worktreePath ? [args.worktreePath] : []),
    '--repo',
    args.repoPath
  ]
  if (args.leaseId) {
    argv.push('--lease-id', args.leaseId)
  }
  if (args.handle) {
    argv.push('--handle', JSON.stringify(args.handle))
  }
  if (args.force === true) {
    argv.push('--force')
  }
  return argv
}

export function buildWorktreeProviderSetupArgv(
  setup: readonly string[],
  args: { repoPath: string; worktreePath: string; profile?: string }
): string[] {
  return appendProfile(
    [...setup, '--path', args.worktreePath, '--repo', args.repoPath],
    args.profile
  )
}

export function buildWorktreeProviderStatusArgv(
  status: readonly string[],
  args: { repoPath: string }
): string[] {
  return [...status, '--repo', args.repoPath]
}

export function providerReleaseArgs(
  provider: WorktreeProviderWorkspace,
  repoPath: string,
  force: boolean
): {
  repoPath: string
  worktreePath?: string
  leaseId?: string
  handle?: Record<string, unknown>
  force: boolean
} {
  return {
    repoPath,
    ...(provider.providerPath ? { worktreePath: provider.providerPath } : {}),
    ...(provider.leaseId ? { leaseId: provider.leaseId } : {}),
    ...(provider.handle ? { handle: provider.handle } : {}),
    force
  }
}
