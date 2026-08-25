import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { hasHostSessionMirrorHydrated } from '@/runtime/host-session-mirror-hydration'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type UnhydratedHostMirror = {
  /** Null when no paired runtime claims the workspace, so nothing will ever answer for the pane. */
  environmentId: string | null
}

/**
 * Reports the mirror a pane is still waiting on, or null when the pane's
 * remote liveness is already decidable.
 *
 * Why: a `web-terminal-*` tab exists only because a host published it, and its
 * PTY handle arrives one relay round trip later. An empty local handle map is
 * therefore "unverifiable", never "exited" — the incident's replacement
 * `codex resume` forked a session the host still held.
 */
export function findUnhydratedHostMirrorForPane(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): UnhydratedHostMirror | null {
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
  if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
    return null
  }
  // Why: once the mirror retracts the tab the host has spoken — the pane is
  // gone, and ordinary recovery owns it again.
  const worktreeTabs = state.tabsByWorktree[record.worktreeId] ?? []
  if (!worktreeTabs.some((tab) => tab.id === tabId)) {
    return null
  }
  // Why: a published PTY handle for the tab is the mirror having spoken for it,
  // whatever the individual leaf's fate.
  if ((state.ptyIdsByTabId[tabId]?.length ?? 0) > 0) {
    return null
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, record.worktreeId)
  if (environmentId && hasHostSessionMirrorHydrated(environmentId, record.worktreeId)) {
    return null
  }
  return { environmentId }
}
