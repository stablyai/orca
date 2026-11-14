import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '../../store/index'
import { isWebRuntimeSessionActive } from '../../runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { moveWebRuntimeSessionTab } from '../../runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move'
import { isDesktopCreatedTabInFrameDrawnServerWorkspace } from '@/store/workspace-layout/frames/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'

export function mirrorWebRuntimeTabMove(
  args: RuntimeMobileSessionTabMove & {
    worktreeId: string
  }
): void {
  const environmentId = runtimeEnvironmentIdOrLocalUnlessTwin(
    useAppStore.getState(),
    args.worktreeId
  )
  if (!isWebRuntimeSessionActive(environmentId)) {
    return
  }
  // Desktop-only tabs move locally; server frames cannot place tabs the server never owned.
  if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    isDesktopCreatedTabInFrameDrawnServerWorkspace(args.worktreeId, args.tabId)
  ) {
    return
  }
  void moveWebRuntimeSessionTab({
    ...args,
    environmentId
  })
}
