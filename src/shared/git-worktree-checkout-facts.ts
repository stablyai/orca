import { isSafeGitRefName } from './git-status-upstream-ref'
import type { GitWorktreeInfo } from './worktree/types'

// Symbol provenance survives internal row spreads but cannot enter saved or wire JSON.
export const worktreeCheckoutEvidence = Symbol('worktreeCheckoutEvidence')

export function isWorktreeHeadOid(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value)
}

export function isWorktreeBranchRef(value: string): boolean {
  return value.startsWith('refs/heads/') && isSafeGitRefName(value)
}

export function hasWorktreeCheckoutEvidence(row: GitWorktreeInfo): boolean {
  return (
    row.isBare ||
    (isWorktreeHeadOid(row.head) &&
      (isWorktreeBranchRef(row.branch) ||
        (row.branch === '' &&
          worktreeCheckoutEvidence in row &&
          row[worktreeCheckoutEvidence] === true)))
  )
}
