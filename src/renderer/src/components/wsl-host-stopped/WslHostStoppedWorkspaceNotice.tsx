import React from 'react'
import type { AppState } from '@/store/types'
import { selectStoppedWslHostEnvironmentId, useStoppedWslHost } from './use-stopped-wsl-host'
import { WslHostStoppedNotice } from './WslHostStoppedNotice'
import { useAppStoreWithChannels } from '@/store/channels/use-app-store-with-channels'

function selectWorkspaceHasNoTabs(state: AppState, worktreeId: string): boolean {
  return (
    (state.unifiedTabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    (state.tabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    (state.browserTabsByWorktree[worktreeId]?.length ?? 0) === 0 &&
    !state.openFiles.some((file) => file.worktreeId === worktreeId)
  )
}

/** A workspace with no tabs on a stopped host would be blank: no terminal seeds until it answers. */
export function WslHostStoppedWorkspaceNotice({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const stoppedWslHost = useStoppedWslHost(worktreeId)
  // Why gated: the tab scan runs on every store change, and almost no workspace is on a stopped host.
  const empty = useAppStoreWithChannels(
    (state) =>
      worktreeId !== null &&
      selectStoppedWslHostEnvironmentId(state, worktreeId) !== null &&
      selectWorkspaceHasNoTabs(state, worktreeId)
  )
  if (!stoppedWslHost || !empty) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <WslHostStoppedNotice
        environmentId={stoppedWslHost.environmentId}
        distro={stoppedWslHost.distro}
        size="sm"
        className="pointer-events-auto text-sm"
      />
    </div>
  )
}
