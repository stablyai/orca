import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime/remote-runtime-pty-id'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { hasHostSessionMirrorHydrated } from '@/runtime/host-session-mirror-hydration'
import { hasHostMirrorHandleWaitExpired } from './host-mirror-handle-gap-wait'
import { runtimeEnvironmentIdForWorkspaceOwner } from './resolve-owner'
import { warnAmbiguousOwnerOnce } from './ambiguous-owner-warning'

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

export function isHostMirroredSleepingRecord(record: SleepingAgentSessionRecord): boolean {
  const tabId =
    record.tabId ??
    parsePaneKey(record.paneKey)?.tabId ??
    parseLegacyNumericPaneKey(record.paneKey)?.tabId
  return Boolean(tabId && isWebTerminalSurfaceTabId(tabId))
}

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

/** Host rows may precede handles by a relay round trip; a layout-bound pane stays unverifiable and needs bounded waiting, never a replacement resume of an agent the host may still run (#19735). */
export function findUnhydratedHostMirrorForPane(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): UnhydratedHostMirror | null {
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId ?? null
  if (!tabId || !isWebTerminalSurfaceTabId(tabId)) {
    return null
  }
  // Missing rows cannot arm a handle wait or authorize a replacement launch.
  const worktreeTabs = state.tabsByWorktree[record.worktreeId] ?? []
  if (!worktreeTabs.some((tab) => tab.id === tabId)) {
    return null
  }
  // A sibling handle ends the tab-level wait without authorizing a replacement launch.
  if ((state.ptyIdsByTabId[tabId]?.length ?? 0) > 0) {
    return null
  }
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: record.worktreeId })
  if (owner.kind === 'ambiguous') {
    // Why: no single host can answer for a twin's pane, so park without arming a wait on either.
    warnAmbiguousOwnerOnce(record.worktreeId, 'wait on an agent resume mirror')
    return { kind: 'mirror', environmentId: null }
  }
  const environmentId = owner.environmentId
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
