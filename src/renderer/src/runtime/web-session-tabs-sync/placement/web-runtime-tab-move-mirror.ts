import type { RuntimeMobileSessionTabMove } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { useAppStore } from '../../../store/index'
import { isWebRuntimeSessionActive } from '../identity/web-runtime-session-environment'
import { moveWebRuntimeSessionTab } from '../actions/web-runtime-session-tab-move'
import { isDesktopCreatedTabInFrameDrawnServerWorkspace } from '@/store/workspace-layout/frames/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/workspace-layout/layout-owner-switch'

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
