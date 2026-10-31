import type { AppState } from '../types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import { sendLayoutApply } from '@/runtime/layout-apply-send'
import { commitTerminalSurfaceClose } from './terminal-surface-close-intent'

/** Record terminal closes via main layout.apply, with legacy intent fallback for server-routed twins; return false for paired-server layouts. */
export function recordTerminalTabCloseThroughLayoutOwner(
  state: WorktreeRuntimeOwnerState & Pick<AppState, 'unifiedTabsByWorktree'>,
  worktreeId: string,
  tabId: string,
  reason: 'user' | 'cleanup'
): boolean {
  // Main's layout names a tab by its tab-bar entry, which a legacy terminal's id can differ from.
  const entryId =
    state.unifiedTabsByWorktree[worktreeId]?.find(
      (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
    )?.id ?? tabId
  const keep = (): void => {}
  return sendLayoutApply(
    state,
    worktreeId,
    { type: 'closeTabs', tabIds: [entryId], recordClose: reason },
    {
      apply: keep,
      asToday: () => commitTerminalSurfaceClose(worktreeId, { kind: 'tab', tabId }, reason),
      drawn: true
    }
  )
}
