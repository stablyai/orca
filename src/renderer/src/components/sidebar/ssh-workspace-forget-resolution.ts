import { isRuntimeOwnedSshTargetId, parseExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'

/** Choose normal deletion or forget-only from the route a removal would take. */
export type SshWorkspaceForgetResolution =
  | { kind: 'not-ssh' }
  // A saved target whose workspace this client can only forget.
  | { kind: 'saved'; targetId: string }
  // Removed targets keep only their local records.
  | { kind: 'ghost'; targetId: string }

export function resolveSshWorkspaceForget(args: {
  route: WorktreeOperationRoute | null
  // Keys are configured SSH target ids (targets that still exist in settings).
  sshTargetLabels: ReadonlyMap<string, string>
}): SshWorkspaceForgetResolution {
  const host = parseExecutionHostId(args.route?.executionHostId)
  // An Orca server deletes the SSH workspaces it serves; this app's main serves no ssh: host, connected or not.
  if (
    host?.kind !== 'ssh' ||
    args.route?.runtimeEnvironmentId ||
    // Runtime-owned ephemeral targets manage their lifecycle and must never become user-facing ghosts.
    isRuntimeOwnedSshTargetId(host.targetId)
  ) {
    return { kind: 'not-ssh' }
  }
  return args.sshTargetLabels.has(host.targetId)
    ? { kind: 'saved', targetId: host.targetId }
    : { kind: 'ghost', targetId: host.targetId }
}
