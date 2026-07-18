import type { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../shared/stable-pane-id'

type AppStoreState = ReturnType<typeof useAppStore.getState>

export function getProviderSessionClaimKey(record: SleepingAgentSessionRecord): string {
  const base = `${record.worktreeId}\0${record.agent}\0${record.providerSession.key}\0${record.providerSession.id}`
  return record.agent === 'pi' ? `${base}\0${record.providerSession.transcriptPath ?? ''}` : base
}

export function isPassiveCompletedHibernationEvidence(record: SleepingAgentSessionRecord): boolean {
  return record.origin !== 'quit' && record.origin !== 'live' && record.state === 'done'
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
  // Why: hibernation intentionally clears the live PTY binding after the pane
  // exits, but the preserved leaf still owns cold-restore for its session.
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

function paneWillConnectOnActivation(
  worktreeId: string,
  tabId: string,
  state: AppStoreState
): boolean {
  if (state.activeWorktreeId !== worktreeId) {
    return false
  }
  if (state.activeTabType === 'terminal' && state.activeTabId === tabId) {
    return true
  }
  // Why: split groups can show multiple terminal tabs at once; each group's
  // active terminal mounts and connects even when another group has focus.
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const unifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  return groups.some((group) => {
    const tab = group.activeTabId
      ? unifiedTabs.find((candidate) => candidate.id === group.activeTabId)
      : null
    return tab?.contentType === 'terminal' && tab.entityId === tabId
  })
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
    const tab = worktreeTabs.find((candidate) => candidate.id === tabId) ?? null
    if (!tab || !hasMatchingStablePaneLayout(tabId, stable.leafId, state.terminalLayoutsByTabId)) {
      return false
    }
    if (isPassiveCompletedHibernationEvidence(record)) {
      return true
    }
    // Why: active sessions rely on pane-level cold restore. A preserved leaf
    // without a PTY/session id can repaint scrollback but cannot resume.
    return (
      hasRestorableStablePanePty(
        tab,
        tabId,
        stable.leafId,
        state.ptyIdsByTabId,
        state.terminalLayoutsByTabId
      ) && paneWillConnectOnActivation(record.worktreeId, tabId, state)
    )
  }

  const tabId = getLegacyPaneTabId(record)
  if (!tabId) {
    return false
  }
  const tab = worktreeTabs.find((candidate) => candidate.id === tabId) ?? null
  const providerKeys = getLegacyProviderSessionKeysForTab(state, record.worktreeId, tabId)
  // Why: legacy numeric pane keys lack leaf identity, so only a preserved
  // tab-level wake hint plus a single provider session is strong enough to
  // claim pane recovery without risking the wrong split-pane session.
  return Boolean(
    tab &&
    (tab.ptyId || (state.ptyIdsByTabId[tab.id]?.length ?? 0) > 0) &&
    providerKeys.size === 1 &&
    paneWillConnectOnActivation(record.worktreeId, tabId, state)
  )
}
