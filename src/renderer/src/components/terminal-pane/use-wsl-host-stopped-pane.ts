import { useAppStore } from '@/store'
import { paneShowsWslHostStoppedCard, selectStoppedWslDistro } from '@/lib/wsl-host-stopped-status'
import { selectWorkspaceRuntimeEnvironmentId } from './remote-server-outage'
import { selectWslHostUnavailableReason } from './use-wsl-host-unavailable-reason'

/**
 * Whether the active pane's raw error toast gives way to the stopped distro's Start card: only
 * where that card shows, so a pane on another server, or a host that cannot run, keeps its error.
 */
export function useWslHostStartCardReplacesPaneError(
  worktreeId: string | null | undefined,
  /** The active pane's server; null when it has none yet, undefined with no active pane. */
  activePaneEnvironmentId: string | null | undefined
): boolean {
  const ownerEnvironmentId = useAppStore((state) =>
    selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  )
  const stoppedWslDistro = useAppStore((state) => selectStoppedWslDistro(state, ownerEnvironmentId))
  // Why behind the stop: every surface subscribes, and most workspaces are not on a stopped host.
  const wslHostUnavailable = useAppStore(
    (state) =>
      stoppedWslDistro !== null && selectWslHostUnavailableReason(state, worktreeId) !== null
  )
  return (
    activePaneEnvironmentId !== undefined &&
    paneShowsWslHostStoppedCard({
      wslHostUnavailable,
      stoppedWslDistro,
      ownerEnvironmentId,
      paneEnvironmentId: activePaneEnvironmentId
    })
  )
}
