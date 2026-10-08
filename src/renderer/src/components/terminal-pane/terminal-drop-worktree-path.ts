import { useAppStore } from '@/store'
import { findKnownWorktreeById } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { resolveExactWorktreeRoute } from '@/lib/worktree-owner-route'
import { isTerminalDropWindowsPathLike } from './terminal-drop-shell'

export function resolveTerminalDropWorktreePath(
  worktreeId: string,
  fallbackCwd: string | undefined,
  executionHostId: ExecutionHostId | null | undefined,
  runtimeEnvironmentId?: string | null
): string | null {
  const host = parseExecutionHostId(executionHostId)
  if (!host) {
    return null
  }
  const environmentId =
    runtimeEnvironmentId ?? (host.kind === 'runtime' ? host.environmentId : null)
  // A runtime's physical local host is a different catalog namespace from the client's local host.
  const catalogHostId = environmentId ? toRuntimeExecutionHostId(environmentId) : host.id
  const state = useAppStore.getState()
  const worktree = findKnownWorktreeById(state, worktreeId, catalogHostId)
  if (host.kind === 'ssh' && environmentId) {
    const resolution = worktree && resolveExactWorktreeRoute(state, worktree)
    if (
      resolution?.kind !== 'resolved' ||
      resolution.route.runtimeEnvironmentId !== environmentId ||
      resolution.route.executionHostId !== host.id
    ) {
      return null
    }
  } else if (environmentId && parseExecutionHostId(worktree?.hostId)?.kind === 'ssh') {
    return null
  }
  return worktree?.path ?? (catalogHostId === 'local' ? fallbackCwd : null) ?? null
}

export function joinRuntimeTerminalDropDir(worktreePath: string): string {
  if (isTerminalDropWindowsPathLike(worktreePath)) {
    return `${worktreePath.replace(/[\\/]+$/, '').replace(/\//g, '\\')}\\.orca\\drops`
  }
  return `${worktreePath.replace(/[\\/]+$/, '')}/.orca/drops`
}
