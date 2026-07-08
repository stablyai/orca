import { getConnectionId } from '@/lib/connection-context'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { resolveTerminalDropTargetShell, type TerminalTargetShell } from './terminal-drop-shell'
import { resolveTerminalDropWorktreePath } from './terminal-drop-worktree-path'
import { getTerminalPasteSshRemotePlatform } from './terminal-paste-ssh-platform'

// Which shell a copied-file paste is quoted for. Reuses the exact drop
// resolution (terminal-native-file-drop.ts) so paste and drop escape paths
// identically for the same worktree — local, SSH, and runtime cases included.
export function resolveTerminalPasteTargetShell({
  worktreeId,
  fallbackCwd
}: {
  worktreeId: string
  fallbackCwd: string | undefined
}): TerminalTargetShell {
  const connectionId = getConnectionId(worktreeId) ?? null
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(
    useAppStore.getState(),
    worktreeId
  )
  const worktreePath = resolveTerminalDropWorktreePath(worktreeId, fallbackCwd)
  return resolveTerminalDropTargetShell({
    activeRuntimeEnvironmentId: runtimeEnvironmentId,
    worktreePath,
    connectionId,
    remotePlatform: getTerminalPasteSshRemotePlatform(connectionId)
  })
}
