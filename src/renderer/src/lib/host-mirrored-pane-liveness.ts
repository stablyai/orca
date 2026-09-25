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
  // not an oversight. For a single-leaf tab (every agent tab Orca creates) it is exact: the mirror
  // builds `ptyIdsByTabId[tab]` out of the same map it writes to the layout's `ptyIdsByLeafId`
  // (web-session-tabs-sync/terminal-build.ts), so a non-empty entry means this leaf is bound and
  // live. For a SPLIT mirrored tab it is not. A leaf that has ever been bound keeps its binding
  // across the gap — `retainPendingTerminalBindings` carries it — so the residual needs a leaf that
  // was NEVER bound, i.e. a cold start or a re-pair with no layout to retain from. There, a sibling
  // surface that reaches `ready` first publishes a handle for the tab while this leaf has none, the
  // pane reads decidable, and the resume fires: #19735 narrowed to a split tab's first frame.
  // It cannot be closed here, because such a leaf holds no binding and the binding is what names a
  // pane in a handle-gap verdict. Closing it means keeping each surface's `pending-handle` status
  // per leaf, which the host already publishes
  // (main/runtime/runtime-mobile-session-projection.ts) and the client consumes but does not retain.
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
