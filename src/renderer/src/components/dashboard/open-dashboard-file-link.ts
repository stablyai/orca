import type { DashboardOpenFileArgs } from '../../../../shared/dashboard-snapshot'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { openDetectedFilePath } from '@/components/terminal-pane/terminal-link-handlers'
import { resolvePaneWslDistro } from '@/components/terminal-pane/terminal-pane-wsl-distro'
import { getConnectionId } from '@/lib/connection-context'
import { resolveExplicitFileLinkTargetPath } from '@/lib/explicit-file-link-target'
import { useAppStore } from '@/store'

/**
 * Follows a file path a dashboard preview terminal linkified. Runs in the MAIN
 * window for both hosts — the in-window drawer calls it directly, the pop-out
 * relays over IPC — because only this window owns the workspace paths and the
 * editor. Resolution and host routing are the pane link's own, so a dashboard
 * link and a pane link land in the same place.
 */
export function openDashboardFileLink(args: DashboardOpenFileArgs): void {
  const state = useAppStore.getState()
  // Host-qualified: the same worktree id can exist on several hosts, and a
  // folder workspace is not in worktreesByRepo at all.
  const worktreePath = state.getKnownWorktreeById(args.worktreeId, args.executionHostId)?.path ?? ''
  const absolutePath = worktreePath
    ? resolveExplicitFileLinkTargetPath(args.path, worktreePath)
    : args.path
  if (!absolutePath) {
    return
  }
  const host = parseExecutionHostId(args.executionHostId)
  openDetectedFilePath(absolutePath, args.line, args.column, {
    worktreeId: args.worktreeId,
    worktreePath,
    runtimeEnvironmentId: host?.kind === 'runtime' ? host.environmentId : null,
    wslDistro: getConnectionId(args.worktreeId)
      ? null
      : resolvePaneWslDistro(state, args.worktreeId, worktreePath),
    openWithSystemDefault: args.openWithSystemDefault === true
  })
}
