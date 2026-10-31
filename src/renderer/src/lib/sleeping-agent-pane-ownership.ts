import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { agentTurnEndedUncleanly } from '../../../shared/agent-main-agent-verdict'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/terminal-tab-types'
import { parseAppSshPtyId } from '../../../shared/ssh-pty-id'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'
import { getProviderSessionClaimKey } from '../../../shared/sleeping-record-legacy-pane-key'
import { isWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { isWorkspaceSleepRecord } from '../../../shared/workspace-sleep'
import { isPaneResumingInPlace, isPaneSpawnDeferred } from './pane-spawn-deferral-registry'

export { getProviderSessionClaimKey }

type AppStoreState = ReturnType<typeof useAppStore.getState>

// Why live+done counts (#16308): workspace activation must not resume a finished turn's idle anchor.
// Quit asks to keep work resumable and a live stopped or failed turn is unfinished.
export function activationTreatsNoteAsFinished(record: SleepingAgentSessionRecord): boolean {
  return (
    record.origin !== 'quit' &&
    !(record.origin === 'live' && agentTurnEndedUncleanly(record)) &&
    record.state === 'done'
  )
}

function getLegacyPaneTabId(record: SleepingAgentSessionRecord): string | null {
  const legacy = parseLegacyNumericPaneKey(record.paneKey)
  if (!legacy || (record.tabId && record.tabId !== legacy.tabId)) {
    return null
  }
  return record.tabId ?? legacy.tabId
}

function getLegacyProviderSessionKeysForTab(
  state: AppStoreState,
  worktreeId: string,
  tabId: string
): Set<string> {
  const keys = new Set<string>()
  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey)) {
    if (record.worktreeId === worktreeId && getLegacyPaneTabId(record) === tabId) {
      keys.add(getProviderSessionClaimKey(record))
    }
  }
  return keys
}

function layoutContainsLeaf(
  node: TerminalPaneLayoutNode | null | undefined,
  leafId: string
): boolean {
  return Boolean(
    node &&
    (node.type === 'leaf'
      ? node.leafId === leafId
      : layoutContainsLeaf(node.first, leafId) || layoutContainsLeaf(node.second, leafId))
  )
}

function hasMatchingStablePaneLayout(
  tabId: string,
  leafId: string,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  // Hibernation clears live binding after exit; the preserved leaf still owns session cold restore.
  return layoutContainsLeaf(terminalLayoutsByTabId[tabId]?.root, leafId)
}

function hasRestorableStablePanePty(
  tab: TerminalTab,
  tabId: string,
  leafId: string,
  ptyIdsByTabId: Record<string, string[] | undefined>,
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
): boolean {
  const layout = terminalLayoutsByTabId[tabId]
  const hasLeafPty = Boolean(layout?.ptyIdsByLeafId?.[leafId])
  const isSingleLeafLayout = layout?.root?.type === 'leaf' && layout.root.leafId === leafId

  return Boolean(
    hasLeafPty || (isSingleLeafLayout && (tab.ptyId || (ptyIdsByTabId[tabId]?.length ?? 0) > 0))
  )
}

// A current live PTY owns even finished-turn sessions (e.g. background Pi); never fork on activation. Use runtime ptyIdsByTabId, not persisted layout bindings that survive sleep/restart stale.
export function stablePaneHasLivePty(
  tabId: string,
  leafId: string,
  ptyIdsByTabId: Record<string, string[]>,
  layout: TerminalLayoutSnapshot | undefined
): boolean {
  const livePtyIds = ptyIdsByTabId[tabId] ?? []
  if (livePtyIds.length === 0) {
    return false
  }
  const leafPtyId = layout?.ptyIdsByLeafId?.[leafId]
  if (leafPtyId) {
    return livePtyIds.includes(leafPtyId)
  }
  // Single-leaf tabs have no per-leaf binding; the tab's live PTY is this leaf's.
  return layout?.root?.type === 'leaf' && layout.root.leafId === leafId
}

function paneWillConnectOnActivation(
  worktreeId: string,
  tabId: string,
  state: AppStoreState
): boolean {
  if (state.activeWorktreeId !== worktreeId) {
    return false
  }
  // Keep-alive eventually mounts every restorable active-worktree pane, so hidden panes own resume too. Visibility gates fork sessions; web mirrors are excluded because they attach host PTYs instead of cold-restoring notes.
  return !isWebTerminalSurfaceTabId(tabId)
}

// Why: a record's worktreeId can be stale (e.g. agent-managed checkout); tab ids are global.
function findPreservedTabOwner(
  state: AppStoreState,
  worktreeIdHint: string,
  tabId: string
): { tab: TerminalTab; worktreeId: string } | null {
  const hinted = (state.tabsByWorktree[worktreeIdHint] ?? []).find(
    (candidate) => candidate.id === tabId
  )
  if (hinted) {
    return { tab: hinted, worktreeId: worktreeIdHint }
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    const tab = tabs.find((candidate) => candidate.id === tabId)
    if (tab) {
      return { tab, worktreeId }
    }
  }
  return null
}

/** A workspace sleep's record whose tab is gone: main has no pane to resume it in, so the window reopens it in a fresh tab (#22657). */
export function isStrandedWorkspaceSleepRecord(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): boolean {
  const tabId = record.tabId ?? parsePaneKey(record.paneKey)?.tabId
  return (
    isWorkspaceSleepRecord(record) &&
    tabId !== undefined &&
    !findPreservedTabOwner(state, record.worktreeId, tabId)
  )
}

export function recordPaneIsOwnedByPreservedPane(
  record: SleepingAgentSessionRecord,
  state: AppStoreState
): boolean {
  const worktreeTabs = state.tabsByWorktree[record.worktreeId] ?? []
  const stable = parsePaneKey(record.paneKey)
  if (stable) {
    if (record.tabId && record.tabId !== stable.tabId) {
      return false
    }
    const tabId = record.tabId ?? stable.tabId
    const owner = findPreservedTabOwner(state, record.worktreeId, tabId)
    if (
      !owner ||
      !hasMatchingStablePaneLayout(tabId, stable.leafId, state.terminalLayoutsByTabId)
    ) {
      return false
    }
    const tab = owner.tab
    if (activationTreatsNoteAsFinished(record)) {
      return true
    }
    // Deferred panes own resume without PTYs; launching elsewhere would put two --resume writers on one transcript.
    if (isPaneSpawnDeferred(record.paneKey)) {
      return true
    }
    // Current live PTYs own sessions regardless of activation reconnect ownership; never launch a duplicate.
    if (
      stablePaneHasLivePty(
        tabId,
        stable.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId[tabId]
      )
    ) {
      return true
    }
    // Disconnect clears the live map while remote processes survive; unreachable SSH is unverifiable. Connected targets’ runtime map is authoritative, including sleep-killed PTYs with preserved IDs.
    const layout = state.terminalLayoutsByTabId[tabId]
    const isSingleLeafLayout = layout?.root?.type === 'leaf' && layout.root.leafId === stable.leafId
    const leafPtyId =
      layout?.ptyIdsByLeafId?.[stable.leafId] ?? (isSingleLeafLayout ? tab.ptyId : null)
    const sshPty = leafPtyId ? parseAppSshPtyId(leafPtyId) : null
    if (sshPty && state.sshConnectionStates.get(sshPty.connectionId)?.status !== 'connected') {
      return true
    }
    // Main clears gone bindings during in-place resume; the active start, not the binding, proves ownership.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && isPaneResumingInPlace(record.paneKey)) {
      return true
    }
    // Scrollback-only leaves without PTY/session IDs can repaint but cannot cold-resume active sessions.
    return (
      hasRestorableStablePanePty(
        tab,
        tabId,
        stable.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId
      ) && paneWillConnectOnActivation(owner.worktreeId, tabId, state)
    )
  }

  const tabId = getLegacyPaneTabId(record)
  if (!tabId) {
    return false
  }
  const tab = worktreeTabs.find((candidate) => candidate.id === tabId) ?? null
  if (tab && isPaneSpawnDeferred(record.paneKey)) {
    return true
  }
  const providerKeys = getLegacyProviderSessionKeysForTab(state, record.worktreeId, tabId)
  // Legacy numeric keys lack leaf identity; require tab wake evidence plus exactly one provider session to avoid claiming the wrong split.
  return Boolean(
    tab &&
    (tab.ptyId || (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) &&
    providerKeys.size === 1 &&
    paneWillConnectOnActivation(record.worktreeId, tabId, state)
  )
}
