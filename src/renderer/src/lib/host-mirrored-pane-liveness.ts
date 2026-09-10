import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { hasHostSessionMirrorHydrated } from '@/runtime/host-session-mirror-hydration'
import { hasHostMirrorHandleWaitExpired } from './host-mirror-handle-gap-wait'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export type UnhydratedHostMirror =
  /** The host's tab rows have not arrived; mirror settlement replays the sweep. */
  | {
      kind: 'mirror'
      /** Null when no paired runtime claims the workspace, so nothing will ever answer for the pane. */
      environmentId: string | null
    }
  /** The rows arrived but this pane's PTY handle has not; a bounded per-pane wait replays. */
  | { kind: 'handle'; environmentId: string; tabId: string }

/** The layout still binds a leaf of this tab to a PTY the environment minted. */
function tabHoldsEnvironmentPtyBinding(
  state: AppStoreState,
  tabId: string,
  environmentId: string
): boolean {
  const bindings = state.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId ?? {}
  return Object.values(bindings).some(
    (ptyId) => parseRemoteRuntimePtyId(ptyId)?.environmentId === environmentId
  )
}

/**
 * Reports the mirror a pane is still waiting on, or null when the pane's
 * remote liveness is already decidable.
 *
 * Why: a `web-terminal-*` tab exists only because a host published it, and its
 * PTY handle arrives one relay round trip later. An empty local handle map is
 * therefore "unverifiable", never "exited" — the incident's replacement
 * `codex resume` forked a session the host still held. Mirror hydration only
 * says the rows landed, so a pane still bound to this environment's PTY with
 * no handle yet gets its own bounded wait (#19735).
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
  if (!environmentId || !hasHostSessionMirrorHydrated(environmentId, record.worktreeId)) {
    return { kind: 'mirror', environmentId }
  }
  if (
    tabHoldsEnvironmentPtyBinding(state, tabId, environmentId) &&
    !hasHostMirrorHandleWaitExpired(environmentId, tabId)
  ) {
    return { kind: 'handle', environmentId, tabId }
  }
  return null
}
