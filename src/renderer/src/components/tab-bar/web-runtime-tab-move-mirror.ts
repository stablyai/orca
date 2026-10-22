import type { RuntimeMobileSessionTabMove } from '../../../../shared/runtime-types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { useAppStore } from '../../store'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session-environment'
import { moveWebRuntimeSessionTab } from '../../runtime/web-runtime-session-tab-move'
import { isDesktopCreatedTabInFrameDrawnServerWorkspace } from '@/lib/frame-drawn-desktop-created-tabs'
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
  // Switch point: a tab only this desktop has moves here only; the server never had it, and its
  // frames keep it where this window drew it.
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
