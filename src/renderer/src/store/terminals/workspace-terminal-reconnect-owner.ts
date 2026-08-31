import type { Repo } from '../../../../shared/repo-types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import type { Worktree } from '../../../../shared/worktree/types'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { normalizeSshConnectionId } from '../../../../shared/ssh-pty-id'
import {
  normalizeWorktreeLookupId,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from '@/lib/worktree-runtime-owner-index'

export type WorkspaceTerminalReconnectOwnerResolution =
  | {
      kind: 'resolved'
      /** Bare SSH target used to look up relay connection state. */
      connectionId?: string | null
      /** Explicit SSH target proven by the worktree/repo owner rows, if any. */
      sshTargetId?: string | null
    }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

/** Build a key resolver that fails closed when catalog ownership is ambiguous. */
export function buildWorkspaceTerminalReconnectOwnerResolver(
  repos: readonly Repo[],
  worktreesByRepo: Record<string, Worktree[]>
): (workspaceSessionKey: string) => WorkspaceTerminalReconnectOwnerResolution {
  return (workspaceSessionKey) => {
    const rawWorktreeId = normalizeWorktreeLookupId(workspaceSessionKey)
    if (rawWorktreeId === null) {
      return { kind: 'missing' }
    }
    const worktreeResolution = resolveIndexedWorktreeOwner(worktreesByRepo, rawWorktreeId)
    if (worktreeResolution.kind === 'ambiguous') {
      return { kind: 'ambiguous' }
    }
    const repoId =
      worktreeResolution.kind === 'resolved'
        ? worktreeResolution.owner.repoId
        : getRepoIdFromWorktreeId(rawWorktreeId)

    // A cold catalog has no worktree row to identify the host. Only use the
    // composite repo id when the repo owner index resolves it unambiguously.
    const resolution = resolveIndexedRepoOwner(repos, repoId)
    if (resolution.kind === 'ambiguous') {
      return resolution
    }
    if (resolution.kind !== 'resolved') {
      // A loaded worktree can still prove a direct SSH owner when its repo row
      // is absent; retain that evidence for target validation.
      const worktreeHost =
        worktreeResolution.kind === 'resolved'
          ? parseExecutionHostId(worktreeResolution.owner.hostId)
          : null
      const worktreeSshTargetId = worktreeHost?.kind === 'ssh' ? worktreeHost.targetId : null
      return worktreeSshTargetId
        ? { kind: 'resolved', connectionId: worktreeSshTargetId, sshTargetId: worktreeSshTargetId }
        : { kind: 'missing' }
    }
    const repoConnectionId = resolution.owner.connectionId?.trim() || null
    const repoHost = parseExecutionHostId(resolution.owner.executionHostId)
    const repoSshTargetId = repoConnectionId
      ? normalizeSshConnectionId(repoConnectionId)
      : repoHost?.kind === 'ssh'
        ? repoHost.targetId
        : null
    const worktreeHost =
      worktreeResolution.kind === 'resolved'
        ? parseExecutionHostId(worktreeResolution.owner.hostId)
        : null
    const worktreeSshTargetId = worktreeHost?.kind === 'ssh' ? worktreeHost.targetId : null
    if (repoSshTargetId && worktreeSshTargetId && repoSshTargetId !== worktreeSshTargetId) {
      // Two explicit targets disagree; choosing either would advertise/reattach
      // a relay PTY on the wrong machine.
      return { kind: 'ambiguous' }
    }
    const sshTargetId = worktreeSshTargetId ?? repoSshTargetId
    return {
      kind: 'resolved',
      connectionId: sshTargetId,
      sshTargetId
    }
  }
}
