import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { recoverWebSessionTerminalOrphansBeforeApply } from '../web-session-terminal-orphan-recovery'
import { isFrameDrawnServerWorkspace } from './frame-drawn-server-workspaces'

/** Orphan recovery for frames the mirror reconciles; a frame-drawn workspace's terminals are not the mirror's to adopt. */
export function recoverMirroredTerminalOrphansBeforeApply(
  ...args: Parameters<typeof recoverWebSessionTerminalOrphansBeforeApply>
): Promise<RuntimeMobileSessionTabsResult | null> {
  const [, frame, environmentId] = args
  // Switch point: ORCA_LAYOUT_OWNER_IS_MAIN && — recovery claims host surfaces for local tabs frames drew.
  if (ORCA_LAYOUT_OWNER_IS_MAIN && isFrameDrawnServerWorkspace(environmentId, frame.worktree)) {
    return Promise.resolve(frame)
  }
  return recoverWebSessionTerminalOrphansBeforeApply(...args)
}
