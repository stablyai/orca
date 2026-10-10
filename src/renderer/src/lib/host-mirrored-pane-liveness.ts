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
  //
  // TAB-GRANULAR, and everything below this line is leaf-aware — the asymmetry is a known residual,
  // not an oversight. For a single-leaf tab, a non-empty live entry identifies that leaf.
  // Layout bindings also retain inactive wake hints; they do not imply a published live handle.
  // A slept binding with no live entry therefore takes the bounded handle wait below.
  // For a SPLIT mirrored tab, a sibling's live handle can still make a pending leaf decidable,
  // whether that pending leaf retains a wake binding or has never been bound. There, a sibling
  // surface that reaches `ready` first publishes a handle for the tab while this leaf has none.
  // Closing the residual needs per-leaf handle status, including leaves without a prior binding;
  // the host publishes it, but the client does not retain it.
  // Pinned as current behaviour by "resumes a pending leaf when a sibling leaf of the same tab
  // holds the only handle" in host-mirror-handle-gap-resume.test.ts.
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
