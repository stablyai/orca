import type { GitWorktreeHostProcessIdentity } from './git-worktree-host-process-identity'

export type GitWorktreeHostClaimOwner = GitWorktreeHostProcessIdentity & {
  token: string
  choosing: boolean
  ticket?: number
}

const TOKEN_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27}$/

export function parseGitWorktreeHostClaimOwner(value: string): GitWorktreeHostClaimOwner | null {
  try {
    const owner = JSON.parse(value) as Partial<GitWorktreeHostClaimOwner>
    if (
      !Number.isSafeInteger(owner.pid) ||
      !Number.isSafeInteger(owner.port) ||
      typeof owner.processToken !== 'string' ||
      typeof owner.token !== 'string' ||
      !TOKEN_PATTERN.test(owner.token) ||
      typeof owner.choosing !== 'boolean' ||
      (!owner.choosing && !Number.isSafeInteger(owner.ticket))
    ) {
      return null
    }
    return owner as GitWorktreeHostClaimOwner
  } catch {
    return null
  }
}
