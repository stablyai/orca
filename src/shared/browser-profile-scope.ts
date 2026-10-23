import { FLOATING_TERMINAL_WORKTREE_ID } from './constants'
import { getRepoIdFromWorktreeId } from './worktree/id'
import { parseWorkspaceKey } from './workspace-scope'

/** Which browser profile new tabs in a workspace use: the shared Default, or one Orca manages per repo or per workspace. */
export type BrowserProfileScope = 'shared' | 'repo' | 'worktree'

export type ManagedBrowserProfileOwner = { kind: 'repo' | 'worktree'; id: string }

export function getManagedBrowserProfileOwner(
  scope: BrowserProfileScope | undefined,
  worktreeId: string
): ManagedBrowserProfileOwner | null {
  if ((scope !== 'repo' && scope !== 'worktree') || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return null
  }
  // Why: a standalone folder workspace belongs to no repo, so it owns its profile under either scope.
  if (scope === 'repo' && parseWorkspaceKey(worktreeId)?.type !== 'folder') {
    return { kind: 'repo', id: getRepoIdFromWorktreeId(worktreeId) }
  }
  return { kind: 'worktree', id: worktreeId }
}

export function managedBrowserProfileOwnerKey(owner: ManagedBrowserProfileOwner): string {
  return `${owner.kind}:${owner.id}`
}

export function isManagedBrowserProfileOf(
  profile: { owner?: ManagedBrowserProfileOwner },
  owner: ManagedBrowserProfileOwner
): boolean {
  return profile.owner?.kind === owner.kind && profile.owner.id === owner.id
}
