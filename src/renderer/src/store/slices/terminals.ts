/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  SetupSplitDirection,
  Tab,
  TerminalLayoutSnapshot,
  TerminalTab,
  TuiAgent,
  Worktree,
  WorkspaceKey,
  WorkspaceSessionState
} from '../../../../shared/types'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { deriveGeneratedTabTitle } from '../../../../shared/agent-tab-title'
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../../../shared/stable-pane-id'
import { isValidHostTerminalTabId, isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import { getRepoIdFromWorktreeId, splitWorktreeId } from '../../../../shared/worktree-id'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../shared/local-windows-terminal-runtime'
import type { AgentStartedTelemetry } from '../../lib/worktree-activation'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import { isClaudeAgent, detectAgentStatusFromTitle } from '@/lib/agent-status'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'
import {
  dedupeTabOrder,
  ensureGroup,
  findTabByEntityInGroup,
  pushRecentTabId,
  sanitizeRecentTabIds,
  updateGroup
} from './tab-group-state'
import {
  ensurePtyDispatcher,
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'
import { normalizeTerminalLayoutSnapshot } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree,
  type AgentStatusWorktreeShutdownReason
} from './agent-status'

function getNextTerminalOrdinal(tabs: TerminalTab[]): number {
  const usedOrdinals = new Set<number>()
  for (const tab of tabs) {
    const match = /^Terminal (\d+)$/.exec(tab.defaultTitle ?? tab.title)
    if (!match) {
      continue
    }
    usedOrdinals.add(Number(match[1]))
  }

  let nextOrdinal = 1
  while (usedOrdinals.has(nextOrdinal)) {
    nextOrdinal += 1
  }
  return nextOrdinal
}

function isRemoteRuntimePtyId(ptyId: string | null | undefined): boolean {
  return typeof ptyId === 'string' && parseRemoteRuntimePtyId(ptyId) !== null
}

function getPendingActivationSpawnCount(value: boolean | number | undefined): number {
  if (value === true) {
    return 1
  }
  return typeof value === 'number' && value > 0 ? value : 0
}

function consumePendingActivationSpawn(
  value: boolean | number | undefined
): boolean | number | undefined {
  const count = getPendingActivationSpawnCount(value)
  if (count <= 1) {
    return undefined
  }
  return count === 2 ? true : count - 1
}

function getFallbackTabTitle(tab: TerminalTab, index?: number): string {
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    tab.defaultTitle?.trim() ||
    tab.title ||
    `Terminal ${(index ?? 0) + 1}`
  )
}

let terminalTabOwnerCacheSource: Record<string, TerminalTab[]> | null = null
let terminalTabOwnerCache = new Map<string, string>()

function getTerminalTabOwnerWorktreeId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string
): string | null {
  if (terminalTabOwnerCacheSource !== tabsByWorktree) {
    const nextCache = new Map<string, string>()
    for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
      for (const tab of tabs) {
        nextCache.set(tab.id, worktreeId)
      }
    }
    terminalTabOwnerCacheSource = tabsByWorktree
    terminalTabOwnerCache = nextCache
  }
  return terminalTabOwnerCache.get(tabId) ?? null
}

function updateUnifiedTerminalLabel(
  unifiedTabs: Tab[],
  terminalTabId: string,
  label: string
): Tab[] | null {
  const unifiedIndex = unifiedTabs.findIndex(
    (entry) => entry.contentType === 'terminal' && entry.entityId === terminalTabId
  )
  if (unifiedIndex === -1 || unifiedTabs[unifiedIndex]?.label === label) {
    return null
  }
  return unifiedTabs.map((entry, index) => (index === unifiedIndex ? { ...entry, label } : entry))
}

function updateUnifiedTerminalGeneratedLabel(
  unifiedTabs: Tab[],
  terminalTabId: string,
  generatedLabel: string
): Tab[] | null {
  const unifiedIndex = unifiedTabs.findIndex(
    (entry) => entry.contentType === 'terminal' && entry.entityId === terminalTabId
  )
  if (unifiedIndex === -1 || unifiedTabs[unifiedIndex]?.generatedLabel === generatedLabel) {
    return null
  }
  return unifiedTabs.map((entry, index) =>
    index === unifiedIndex ? { ...entry, generatedLabel } : entry
  )
}

function getTabIdFromPaneKey(paneKey: string): string | null {
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

function isWindowsRendererRuntime(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows')
}

function resolveCreatedTabShellOverride(
  explicitShellOverride: string | undefined,
  defaultWindowsShell: string | undefined,
  isRemoteWorktree: boolean,
  isWslWorktree: boolean,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | undefined {
  if (isRemoteWorktree) {
    return undefined
  }
  if (isWindowsRendererRuntime()) {
    return resolveLocalWindowsTerminalShellOverrideForTab({
      explicitShellOverride,
      defaultWindowsShell,
      isWslWorktree,
      projectRuntime
    })
  }
  if (explicitShellOverride !== undefined) {
    return explicitShellOverride
  }
  return undefined
}

function worktreeUsesWslPath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsed = parseWorkspaceKey(worktreeId)
  if (parsed?.type === 'folder') {
    const folderWorkspace = state.folderWorkspaces.find(
      (workspace) => workspace.id === parsed.folderWorkspaceId
    )
    return folderWorkspace ? isWslUncPath(folderWorkspace.folderPath) : false
  }
  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  return worktree ? isWslUncPath(worktree.path) : false
}

export function worktreeUsesRemoteConnection(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): boolean {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return Boolean(getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId))
  }
  const directRepoId = getRepoIdFromWorktreeId(worktreeId)
  const directRepo = state.repos.find((repo) => repo.id === directRepoId)
  if (directRepo) {
    return Boolean(directRepo.connectionId)
  }

  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  return Boolean(repo?.connectionId)
}

function resolveTerminalStopRuntimeEnvironmentId(
  state: Pick<AppState, 'repos' | 'settings' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId)
}

function sortedUniquePtyIds(ptyIds: readonly string[] | undefined): string[] {
  return [...new Set((ptyIds ?? []).filter((ptyId) => ptyId.length > 0))].sort()
}

function equalStringSets(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  const bSet = new Set(b)
  return a.every((value) => bSet.has(value))
}

export type TerminalSlice = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  /** Per-worktree last-active terminal tab — restored on worktree switch so
   *  the user returns to the same tab they left, not always tabs[0]. */
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, string[]>
  /** Live pane titles keyed by tabId then paneId. Unlike the legacy tab title,
   *  this preserves split-pane agent status per pane while TerminalPane is mounted. */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** Why: per-tab activity indicators. A tab gets flagged unread when terminal
   *  output requests attention (BEL) or an agent-complete notification is
   *  dispatched for one of its panes. The flag clears when the user activates
   *  or interacts with the tab. This is ephemeral UI state only — not
   *  persisted across restarts. */
  unreadTerminalTabs: Record<string, true>
  /** Pane-keyed attention marker for split-pane precision. This is narrower
   *  than unreadTerminalTabs and clears when the user interacts with the exact
   *  pane that raised attention. */
  unreadTerminalPanes: Record<string, true>
  /** Agent-completion source marker for focus-return auto-ack. Kept separate
   *  from unreadTerminalPanes so generic terminal bells still show until interact. */
  unreadAgentCompletionPanes: Record<string, true>
  suppressedPtyExitIds: Record<string, true>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Most recently run quick-command id per tab group. In-memory only; resets
   *  on app restart so a stale id from a deleted command can't surface as the
   *  split-button label across sessions. */
  recentQuickCommandIdByGroup: Record<string, string>
  setRecentQuickCommandForGroup: (groupId: string, quickCommandId: string) => void
  pendingStartupByTabId: Record<
    string,
    {
      command: string
      /** Renderer-delivered startup input for callers that need xterm paste
       *  semantics before the submit Enter. */
      delivery?: 'terminal-paste'
      startupCommandDelivery?: StartupCommandDelivery
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      /** Initial prompt-start status for agents that lack native prompt hooks. */
      initialAgentStatus?: { agent: TuiAgent; prompt: string }
      /** Show the restored-session banner when this startup command mounts. */
      showSessionRestoredBanner?: boolean
      /** Telemetry metadata for the `agent_started` event. Threaded all the
       *  way to the `pty:spawn` IPC handler in main so the event fires only
       *  after spawn confirms — never on click-intent. */
      telemetry?: AgentStartedTelemetry
    }
  >
  /** Queued setup-split requests — when present, TerminalPane creates the
   *  initial pane clean, then splits (vertical or horizontal per user setting)
   *  and runs the command in the new pane so the main terminal stays
   *  immediately interactive. */
  pendingSetupSplitByTabId: Record<
    string,
    { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  >
  /** Queued issue-command-split requests — similar to setup splits but triggered
   *  when an issue is linked during worktree creation and the repo's issue
   *  automation command is enabled. */
  pendingIssueCommandSplitByTabId: Record<string, { command: string; env?: Record<string, string> }>
  tabBarOrderByWorktree: Record<string, string[]>
  workspaceSessionReady: boolean
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  markDefaultTerminalTabsApplied: (worktreeId: string) => void
  /** True only after hydrateWorkspaceSession ran from a real load of
   *  orca-data.json. Guards the debounced session writer so that a crash
   *  during early startup (fetchRepos / fetchAllWorktrees / session.get /
   *  hydrateWorkspaceSession itself) cannot cause an empty in-memory state
   *  to be serialized back over the user's good data on disk.
   *  Kept separate from workspaceSessionReady, which still flips true in
   *  the error path so the UI can mount without a rich session. */
  hydrationSucceeded: boolean
  setHydrationSucceeded: (value: boolean) => void
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  /** Maps tabId → previous ptyId from the last session. When the PTY backend is
   *  a daemon, the old ptyId doubles as the daemon sessionId — passing it to
   *  spawn triggers createOrAttach which returns the surviving terminal snapshot. */
  pendingReconnectPtyIdByTabId: Record<string, string>
  // Why: relay session IDs (e.g. pty-0) are stored in tab.ptyId, but
  // clearTabPtyId nulls it on disconnect.  This map preserves the last
  // known ID so the session save can capture it even when the relay mux
  // is temporarily down — without it, remoteSessionIdsByTabId would be
  // empty and the relay PTY could not be reattached after restart.
  lastKnownRelayPtyIdByTabId: Record<string, string>
  /** ANSI snapshots returned by daemon reattach, keyed by the new ptyId.
   *  TerminalPane writes these to xterm.js to restore visual state. */
  pendingSnapshotByPtyId: Record<
    string,
    { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean }
  >
  consumePendingSnapshot: (
    ptyId: string
  ) => { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean } | null
  /** Cold restore data from disk history after a daemon crash, keyed by
   *  the new ptyId. Contains read-only scrollback to display above the
   *  fresh shell prompt. */
  pendingColdRestoreByPtyId: Record<string, { scrollback: string; cwd: string }>
  consumePendingColdRestore: (ptyId: string) => { scrollback: string; cwd: string } | null
  createTab: (
    worktreeId: string,
    targetGroupId?: string,
    shellOverride?: string,
    options?: {
      pendingActivationSpawn?: boolean
      initialPtyId?: string
      activate?: boolean
      recordInteraction?: boolean
      /** Pre-allocated tab id (e.g. minted by main for CLI/runtime-spawned
       *  terminals whose PTY env already carries a pane key). Falls back to
       *  minting a fresh id when omitted or when the supplied id collides
       *  with an existing tab anywhere in the store (tabIds form the global
       *  paneKey namespace, so collisions are checked across all worktrees). */
      id?: string
      /** Coding-harness agent being launched in this tab, recorded so the tab
       *  bar can show the provider icon before the agent's first hook event. */
      launchAgent?: TuiAgent
      quickCommandLabel?: string | null
    }
  ) => TerminalTab
  openNewTerminalTabInActiveWorkspace: (groupId: string) => Promise<void>
  closeTab: (tabId: string, opts?: { recordInteraction?: boolean }) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  setActiveTabForWorktree: (worktreeId: string, tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  setGeneratedTabTitleFromAgentPrompt: (paneKey: string, prompt: string) => void
  clearTabLaunchAgent: (tabId: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  /** Mark a tab as having unread activity (agent working→idle transition).
   *  Skipped when the tab is currently visible to the user — either as
   *  the global active terminal tab, or as the active tab of any split
   *  group within the active worktree. A visible tab is already "seen",
   *  so a flag would never clear naturally. */
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  markAgentCompletionPaneUnread: (paneKey: string) => void
  /** Clear a tab's unread indicator. Called on user interaction with the
   *  pane (keystroke, click) — matches ghostty's "show until interact"
   *  model where the bell stays visible until the user engages with the
   *  surface that raised it. */
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  setTabCustomTitle: (
    tabId: string,
    title: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabColor: (tabId: string, color: string | null) => void
  updateTabPtyId: (tabId: string, ptyId: string) => void
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  shutdownWorktreeTerminals: (
    worktreeId: string,
    opts?: {
      keepIdentifiers?: boolean
      shutdownReason?: AgentStatusWorktreeShutdownReason
      sleepingPaneKeys?: string[]
      expectedRuntimePtyIds?: string[]
    }
  ) => Promise<void>
  shutdownCompletedAgentPaneForHibernation: (
    worktreeId: string,
    opts: {
      paneKey: string
      tabId: string
      leafId: string
      ptyId: string
      expectedRuntimePtyId?: string
    }
  ) => Promise<void>
  suppressPtyExit: (ptyId: string) => void
  consumeSuppressedPtyExit: (ptyId: string) => boolean
  queueCodexPaneRestarts: (ptyIds: string[]) => void
  consumePendingCodexPaneRestart: (ptyId: string) => boolean
  markCodexRestartNotices: (
    notices: { ptyId: string; previousAccountLabel: string; nextAccountLabel: string }[]
  ) => void
  clearCodexRestartNotice: (ptyId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  queueTabStartupCommand: (
    tabId: string,
    startup: {
      command: string
      delivery?: 'terminal-paste'
      startupCommandDelivery?: StartupCommandDelivery
      env?: Record<string, string>
      launchConfig?: SleepingAgentLaunchConfig
      launchToken?: string
      launchAgent?: TuiAgent
      initialAgentStatus?: { agent: TuiAgent; prompt: string }
      showSessionRestoredBanner?: boolean
      telemetry?: AgentStartedTelemetry
    }
  ) => void
  consumeTabStartupCommand: (tabId: string) => {
    command: string
    delivery?: 'terminal-paste'
    startupCommandDelivery?: StartupCommandDelivery
    env?: Record<string, string>
    launchConfig?: SleepingAgentLaunchConfig
    launchToken?: string
    launchAgent?: TuiAgent
    initialAgentStatus?: { agent: TuiAgent; prompt: string }
    showSessionRestoredBanner?: boolean
    telemetry?: AgentStartedTelemetry
  } | null
  queueTabSetupSplit: (
    tabId: string,
    startup: { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  ) => void
  consumeTabSetupSplit: (
    tabId: string
  ) => { command: string; env?: Record<string, string>; direction: SetupSplitDirection } | null
  queueTabIssueCommandSplit: (
    tabId: string,
    issueCommand: { command: string; env?: Record<string, string> }
  ) => void
  consumeTabIssueCommandSplit: (
    tabId: string
  ) => { command: string; env?: Record<string, string> } | null
  /** Per-pane timestamp (ms) when the prompt-cache countdown started (agent became idle).
   *  Keys are `${tabId}:${leafId}` composites so split-pane tabs can track each pane
   *  independently. null means no active timer for that pane. */
  cacheTimerByKey: Record<string, number | null>
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  /** Wall-clock user input markers keyed by paneKey. Hibernation uses these to
   *  avoid sleeping a completed agent pane that the user has turned into a shell. */
  lastTerminalInputAtByPaneKey: Record<string, number>
  recordTerminalInput: (paneKey: string, timestamp?: number) => void
  /** Scan all tabs and seed cache timers for any idle Claude sessions that don't
   *  already have a timer. Called when the feature is enabled mid-session. */
  seedCacheTimersForIdleTabs: () => void
  /** SSH target IDs that require a passphrase — deferred to on-demand
   *  reconnect when the user focuses an affected terminal tab. */
  deferredSshReconnectTargets: string[]
  /** Maps tabId → remote PTY session ID for tabs whose SSH target was
   *  deferred (passphrase-protected). Persisted across the startup clear
   *  of pendingReconnectPtyIdByTabId because the deferred reconnect runs
   *  later, on tab focus. */
  deferredSshSessionIdsByTabId: Record<string, string>
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  removeDeferredSshReconnectTarget: (targetId: string) => void
  removeDeferredSshSessionId: (tabId: string) => void
  hydrateWorkspaceSession: (session: WorkspaceSessionState) => void
  reconnectPersistedTerminals: (signal?: AbortSignal) => Promise<void>
}

export const createTerminalSlice: StateCreator<AppState, [], [], TerminalSlice> = (set, get) => ({
  tabsByWorktree: {},
  activeTabId: null,
  activeTabIdByWorktree: {},
  ptyIdsByTabId: {},
  runtimePaneTitlesByTabId: {},
  unreadTerminalTabs: {},
  unreadTerminalPanes: {},
  unreadAgentCompletionPanes: {},
  suppressedPtyExitIds: {},
  pendingCodexPaneRestartIds: {},
  codexRestartNoticeByPtyId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  pendingStartupByTabId: {},
  pendingSetupSplitByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,
  defaultTerminalTabsAppliedByWorktreeId: {},
  markDefaultTerminalTabsApplied: (worktreeId) =>
    set((s) => {
      if (s.defaultTerminalTabsAppliedByWorktreeId[worktreeId]) {
        return {}
      }
      return {
        defaultTerminalTabsAppliedByWorktreeId: {
          ...s.defaultTerminalTabsAppliedByWorktreeId,
          [worktreeId]: true
        }
      }
    }),
  hydrationSucceeded: false,
  setHydrationSucceeded: (value) => {
    set({ hydrationSucceeded: value })
  },
  pendingReconnectWorktreeIds: [],
  pendingReconnectTabByWorktree: {},
  pendingReconnectPtyIdByTabId: {},
  lastKnownRelayPtyIdByTabId: {},
  pendingSnapshotByPtyId: {},
  pendingColdRestoreByPtyId: {},
  deferredSshReconnectTargets: [],
  deferredSshSessionIdsByTabId: {},
  cacheTimerByKey: {},
  lastTerminalInputAtByPaneKey: {},
  recentQuickCommandIdByGroup: {},

  setRecentQuickCommandForGroup: (groupId, quickCommandId) => {
    set((s) => ({
      recentQuickCommandIdByGroup: {
        ...s.recentQuickCommandIdByGroup,
        [groupId]: quickCommandId
      }
    }))
  },

  recordTerminalInput: (paneKey, timestamp = Date.now()) => {
    if (!paneKey || !Number.isFinite(timestamp)) {
      return
    }
    set((s) => ({
      lastTerminalInputAtByPaneKey: {
        ...s.lastTerminalInputAtByPaneKey,
        [paneKey]: timestamp
      }
    }))
  },

  setCacheTimerStartedAt: (key, ts) => {
    set((s) => {
      const next = { ...s.cacheTimerByKey, [key]: ts }
      // Why: when a real pane transition writes a key like `${tabId}:${leafId}`,
      // clean up any `${tabId}:seed` sentinel left by seedCacheTimersForIdleTabs.
      // This prevents phantom timers when the seeded key doesn't match the real
      // pane ID (e.g., idle Claude in pane 2 of a split tab).
      const colonIdx = key.indexOf(':')
      if (colonIdx !== -1) {
        const tabId = key.slice(0, colonIdx)
        const suffix = key.slice(colonIdx + 1)
        if (suffix !== 'seed') {
          delete next[`${tabId}:seed`]
        }
      }
      return { cacheTimerByKey: next }
    })
  },

  seedCacheTimersForIdleTabs: () => {
    // Why: when the user enables the cache timer feature mid-session, any Claude
    // tabs that are already idle won't have a timer because the working→idle
    // transition already happened. Scan all tabs and seed timers for idle Claude
    // sessions that don't already have one.
    const s = get()
    const now = Date.now()
    const updates: Record<string, number> = {}
    for (const tabs of Object.values(s.tabsByWorktree)) {
      for (const tab of tabs) {
        if (!tab.title || !isClaudeAgent(tab.title)) {
          continue
        }
        const status = detectAgentStatusFromTitle(tab.title)
        if (status === null || status === 'working') {
          continue
        }
        // Why: the store doesn't know which pane holds the idle Claude session,
        // so we use a sentinel suffix. The `setCacheTimerStartedAt` action
        // automatically cleans up `:seed` entries when any real pane transition
        // writes to the same tab, preventing phantom timers.
        const key = `${tab.id}:seed`
        if (s.cacheTimerByKey[key] == null) {
          updates[key] = now
        }
      }
    }
    if (Object.keys(updates).length > 0) {
      set((s) => ({
        cacheTimerByKey: { ...s.cacheTimerByKey, ...updates }
      }))
    }
  },

  setDeferredSshReconnectTargets: (targetIds) => set({ deferredSshReconnectTargets: targetIds }),
  removeDeferredSshReconnectTarget: (targetId) =>
    set((s) => ({
      deferredSshReconnectTargets: s.deferredSshReconnectTargets.filter((id) => id !== targetId)
    })),
  removeDeferredSshSessionId: (tabId) =>
    set((s) => {
      if (!s.deferredSshSessionIdsByTabId[tabId]) {
        return {}
      }
      const next = { ...s.deferredSshSessionIdsByTabId }
      delete next[tabId]
      return { deferredSshSessionIdsByTabId: next }
    }),

  createTab: (worktreeId, targetGroupId, shellOverride, options) => {
    let tab!: TerminalTab
    set((s) => {
      const orphanTerminalIds = getOrphanTerminalIds(s, worktreeId)
      const orphanCleanupPatch = buildOrphanTerminalCleanupPatch(s, worktreeId, orphanTerminalIds)
      const existing = (s.tabsByWorktree[worktreeId] ?? []).filter(
        (entry) => !orphanTerminalIds.has(entry.id)
      )
      // Why: caller-supplied id (e.g. main pre-allocates the tabId for CLI
      // background terminals so the paneKey env baked into the PTY matches
      // the renderer's tab id). Fall back to minting if the id collides — a
      // collision would alias two distinct PTYs to one tab id and silently
      // corrupt agent-status routing. Hook attribution degrades for that
      // single terminal because paneKey is already baked into PTY env, but
      // the rest of the tab works normally. See docs/cli-terminal-hook-pane-key.md.
      // Why: only honor a hint that's a non-empty trimmed string. The IPC
      // boundary at useIpcEvents.ts spreads `id` whenever `tabId !== undefined`,
      // so a stray `''` or whitespace-only value from a future producer would
      // otherwise be persisted as a real tab id and break paneKey routing
      // (`${tabId}:${leafId}` would inherit the bad tab segment).
      const trimmedHint = typeof options?.id === 'string' ? options.id.trim() : ''
      const hintedId =
        trimmedHint.length > 0 && isValidHostTerminalTabId(trimmedHint) ? trimmedHint : undefined
      const idCollides =
        hintedId !== undefined &&
        Object.values(s.tabsByWorktree).some((tabs) => tabs.some((entry) => entry.id === hintedId))
      if (idCollides) {
        console.warn(
          `[createTab] tabId hint ${hintedId} already exists; minting a fresh id (hook attribution will degrade for this terminal)`
        )
      }
      const id = hintedId !== undefined && !idCollides ? hintedId : createBrowserUuid()
      const shouldActivate = options?.activate !== false
      const nextOrdinal = getNextTerminalOrdinal(existing)
      const defaultTitle = `Terminal ${nextOrdinal}`
      const quickCommandLabel = options?.quickCommandLabel?.trim()
      const isRemoteWorktree = worktreeUsesRemoteConnection(s, worktreeId)
      const isWslWorktree = worktreeUsesWslPath(s, worktreeId)
      const createdShellOverride = resolveCreatedTabShellOverride(
        shellOverride,
        s.settings?.terminalWindowsShell,
        // Why: SSH PTYs ignore local Windows shell selection; persisting a
        // local shell icon would mislabel a remote terminal.
        isRemoteWorktree,
        // Why: WSL UNC worktrees are repo-scoped WSL environments. New default
        // terminals should enter that distro even when the global Windows shell
        // preference is PowerShell or cmd.exe.
        isWslWorktree,
        isRemoteWorktree ? undefined : getLocalProjectExecutionRuntimeContext(s, worktreeId)
      )
      tab = {
        id,
        // Why: CLI-created background sessions already own a PTY; revealing
        // one later should attach the pane instead of spawning a duplicate.
        ptyId: options?.initialPtyId ?? null,
        worktreeId,
        // Why: users expect terminal labels to reflect the currently open set,
        // not a monotonic creation counter. Reusing the lowest free ordinal
        // keeps a lone fresh terminal at "Terminal 1" after older tabs close.
        title: defaultTitle,
        defaultTitle,
        ...(quickCommandLabel ? { quickCommandLabel } : {}),
        customTitle: null,
        color: null,
        sortOrder: existing.length,
        createdAt: Date.now(),
        ...(createdShellOverride !== undefined ? { shellOverride: createdShellOverride } : {}),
        ...(options?.launchAgent ? { launchAgent: options.launchAgent } : {}),
        // Why: when Terminal.tsx's activation fallback auto-creates a tab for a
        // first-visit worktree, the resulting PTY spawn is caused by the user
        // clicking the worktree, not by work happening in it. Tagging the tab
        // lets updateTabPtyId suppress the activity bump and sortEpoch bump.
        // Without this, clicking a never-visited worktree would stamp
        // lastActivityAt and reorder Recent/Smart on click — same bug class as
        // the generation-bump → remount path, different code path.
        ...(options?.pendingActivationSpawn ? { pendingActivationSpawn: true } : {})
      }
      const validTargetGroupId =
        targetGroupId && s.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
          ? targetGroupId
          : undefined
      const { group, groupsByWorktree, activeGroupIdByWorktree } = ensureGroup(
        s.groupsByWorktree,
        s.activeGroupIdByWorktree,
        worktreeId,
        validTargetGroupId ?? s.activeGroupIdByWorktree[worktreeId]
      )
      const nextActiveGroupIdByWorktree =
        shouldActivate && validTargetGroupId
          ? { ...activeGroupIdByWorktree, [worktreeId]: validTargetGroupId }
          : activeGroupIdByWorktree
      const existingUnifiedTabs = s.unifiedTabsByWorktree[worktreeId] ?? []
      const existingTerminalTab = findTabByEntityInGroup(
        s.unifiedTabsByWorktree,
        worktreeId,
        group.id,
        id,
        'terminal'
      )
      const groupsForWorktree = groupsByWorktree[worktreeId] ?? []
      const cleanedGroups =
        orphanTerminalIds.size === 0
          ? groupsForWorktree
          : groupsForWorktree.map((entry) => {
              // Why: orphan cleanup must repair every group before adding the
              // new tab, or inactive/background creation can revive stale focus.
              const tabOrder = dedupeTabOrder(entry.tabOrder).filter(
                (tabId) => !orphanTerminalIds.has(tabId)
              )
              const recentTabIds = sanitizeRecentTabIds(entry.recentTabIds, tabOrder)
              const replacedActiveTabId = Boolean(
                entry.activeTabId && orphanTerminalIds.has(entry.activeTabId)
              )
              const fallbackActiveTabId = recentTabIds.at(-1) ?? tabOrder[0] ?? null
              const activeTabId = replacedActiveTabId ? fallbackActiveTabId : entry.activeTabId
              return {
                ...entry,
                activeTabId,
                tabOrder,
                recentTabIds:
                  replacedActiveTabId && activeTabId
                    ? pushRecentTabId(recentTabIds, activeTabId)
                    : recentTabIds
              }
            })
      const cleanedTargetGroup = cleanedGroups.find((entry) => entry.id === group.id) ?? group
      const cleanedGroupOrder = dedupeTabOrder(cleanedTargetGroup.tabOrder).filter(
        (tabId) => !orphanTerminalIds.has(tabId)
      )
      const unifiedTab = existingTerminalTab ?? {
        id,
        entityId: id,
        groupId: group.id,
        worktreeId,
        contentType: 'terminal' as const,
        label: tab.title,
        ...(tab.quickCommandLabel?.trim()
          ? { quickCommandLabel: tab.quickCommandLabel.trim() }
          : {}),
        customLabel: tab.customTitle,
        color: tab.color,
        sortOrder: cleanedGroupOrder.length,
        createdAt: tab.createdAt
      }
      const nextGroupOrder = dedupeTabOrder([...cleanedGroupOrder, unifiedTab.id])
      const nextRecent = shouldActivate
        ? pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, nextGroupOrder), unifiedTab.id)
        : sanitizeRecentTabIds(cleanedTargetGroup.recentTabIds, nextGroupOrder)
      const cleanedActiveTabIdForWorktree = orphanCleanupPatch.activeTabIdByWorktree[worktreeId]
      const cleanedGroupActiveTabId =
        cleanedTargetGroup.activeTabId && !orphanTerminalIds.has(cleanedTargetGroup.activeTabId)
          ? cleanedTargetGroup.activeTabId
          : null
      const nextActiveTabIdForWorktree = shouldActivate
        ? tab.id
        : (cleanedActiveTabIdForWorktree ?? cleanedGroupActiveTabId ?? tab.id)
      return {
        ...orphanCleanupPatch,
        tabsByWorktree: {
          ...orphanCleanupPatch.tabsByWorktree,
          [worktreeId]: [...existing, tab]
        },
        // Why: task-page launch queues startup/setup work before React mounts
        // the terminal. Publishing the unified tab atomically with the runtime
        // tab prevents a transient legacy mount from racing the split host.
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          [worktreeId]: existingTerminalTab
            ? existingUnifiedTabs
            : [...existingUnifiedTabs, unifiedTab]
        },
        groupsByWorktree: {
          ...groupsByWorktree,
          [worktreeId]: updateGroup(cleanedGroups, {
            ...cleanedTargetGroup,
            activeTabId: shouldActivate
              ? unifiedTab.id
              : (cleanedGroupActiveTabId ?? unifiedTab.id),
            tabOrder: nextGroupOrder,
            recentTabIds: nextRecent
          })
        },
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        layoutByWorktree: {
          ...s.layoutByWorktree,
          [worktreeId]: s.layoutByWorktree[worktreeId] ?? { type: 'leaf', groupId: group.id }
        },
        activeTabId: shouldActivate ? tab.id : orphanCleanupPatch.activeTabId,
        activeTabIdByWorktree: {
          ...orphanCleanupPatch.activeTabIdByWorktree,
          [worktreeId]: nextActiveTabIdForWorktree
        },
        ptyIdsByTabId: {
          ...orphanCleanupPatch.ptyIdsByTabId,
          [tab.id]: options?.initialPtyId ? [options.initialPtyId] : []
        },
        terminalLayoutsByTabId: {
          ...orphanCleanupPatch.terminalLayoutsByTabId,
          [tab.id]: emptyLayoutSnapshot()
        }
      }
    })
    const shouldRecordInteraction =
      options?.recordInteraction ?? (!options?.pendingActivationSpawn && !options?.initialPtyId)
    if (shouldRecordInteraction) {
      get().recordFeatureInteraction?.('terminal-tabs')
    }
    return tab
  },

  openNewTerminalTabInActiveWorkspace: async (groupId) => {
    const state = get()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      return
    }
    const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (runtimeEnvironmentId) {
      const { createWebRuntimeSessionTerminal } = await import('@/runtime/web-runtime-session')
      await createWebRuntimeSessionTerminal({
        worktreeId,
        environmentId: runtimeEnvironmentId,
        targetGroupId: groupId,
        activate: true
      })
      return
    }
    const terminal = get().createTab(worktreeId, groupId)
    get().setActiveTab(terminal.id)
    get().setActiveTabType('terminal')
    const latest = get()
    const currentTerminals = latest.tabsByWorktree[worktreeId] ?? []
    const currentEditors = latest.openFiles.filter((file) => file.worktreeId === worktreeId)
    const currentBrowsers = latest.browserTabsByWorktree[worktreeId] ?? []
    const stored = latest.tabBarOrderByWorktree[worktreeId]
    const validIds = new Set([
      ...currentTerminals.map((tab) => tab.id),
      ...currentEditors.map((file) => file.id),
      ...currentBrowsers.map((tab) => tab.id)
    ])
    const base = (stored ?? []).filter((id) => validIds.has(id))
    const inBase = new Set(base)
    for (const id of validIds) {
      if (!inBase.has(id)) {
        base.push(id)
      }
    }
    // Why: Cmd+J uses the same creation path as the titlebar button, so a new
    // terminal should append after mixed editor/browser tabs rather than jump first.
    get().setTabBarOrder(worktreeId, [...base.filter((id) => id !== terminal.id), terminal.id])
    focusTerminalTabSurface(terminal.id)
  },

  closeTab: (tabId, opts) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      let closingPtyId: string | null = null
      for (const wId of Object.keys(next)) {
        const before = next[wId]
        if (!closingPtyId) {
          closingPtyId = before.find((t) => t.id === tabId)?.ptyId ?? null
        }
        const after = before.filter((t) => t.id !== tabId)
        if (after.length !== before.length) {
          next[wId] = after
        }
      }
      const nextExpanded = { ...s.expandedPaneByTabId }
      delete nextExpanded[tabId]
      const nextCanExpand = { ...s.canExpandPaneByTabId }
      delete nextCanExpand[tabId]
      const nextLayouts = { ...s.terminalLayoutsByTabId }
      delete nextLayouts[tabId]
      const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
      delete nextPtyIdsByTabId[tabId]
      const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
      delete nextLastKnownRelay[tabId]
      const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
      delete nextRuntimePaneTitlesByTabId[tabId]
      // Why: preserve the unreadTerminalTabs reference when the closing tab had
      // no unread flag — avoids a no-op top-level state allocation that would
      // force re-evaluation of full-state selectors on unrelated closeTab calls.
      // Mirrors the sibling pattern in tabs.ts (focusGroup, reconcileWorktreeTabModel).
      let nextUnreadTerminalTabs = s.unreadTerminalTabs
      if (s.unreadTerminalTabs[tabId]) {
        nextUnreadTerminalTabs = { ...s.unreadTerminalTabs }
        delete nextUnreadTerminalTabs[tabId]
      }
      let nextUnreadTerminalPanes = s.unreadTerminalPanes
      for (const paneKey of Object.keys(s.unreadTerminalPanes)) {
        if (paneKey.startsWith(`${tabId}:`)) {
          if (nextUnreadTerminalPanes === s.unreadTerminalPanes) {
            nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
          }
          delete nextUnreadTerminalPanes[paneKey]
        }
      }
      let nextUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes
      for (const paneKey of Object.keys(s.unreadAgentCompletionPanes)) {
        if (paneKey.startsWith(`${tabId}:`)) {
          if (nextUnreadAgentCompletionPanes === s.unreadAgentCompletionPanes) {
            nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
          }
          delete nextUnreadAgentCompletionPanes[paneKey]
        }
      }
      const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
      for (const paneKey of Object.keys(nextLastTerminalInputAtByPaneKey)) {
        if (paneKey.startsWith(`${tabId}:`)) {
          delete nextLastTerminalInputAtByPaneKey[paneKey]
        }
      }
      const nextPendingStartupByTabId = { ...s.pendingStartupByTabId }
      delete nextPendingStartupByTabId[tabId]
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      delete nextPendingSetupSplitByTabId[tabId]
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      delete nextPendingIssueCommandSplitByTabId[tabId]
      const nextCacheTimer = { ...s.cacheTimerByKey }
      // Why: cache timer keys are `${tabId}:${leafId}` composites. Remove all
      // entries for the closing tab, regardless of how many panes it had.
      for (const key of Object.keys(nextCacheTimer)) {
        if (key.startsWith(`${tabId}:`)) {
          delete nextCacheTimer[key]
        }
      }
      // Why: keep activeTabIdByWorktree in sync when a tab is closed in a
      // background worktree. Without this, the remembered tab becomes stale
      // and restoring it on worktree switch falls back to tabs[0].
      const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
      for (const [wId, tabs] of Object.entries(next)) {
        if (nextActiveTabIdByWorktree[wId] === tabId) {
          nextActiveTabIdByWorktree[wId] = tabs[0]?.id ?? null
        }
      }

      // Why: keep tabBarOrderByWorktree in sync so stale terminal IDs don't
      // linger and cause position shifts on subsequent tab operations.
      const nextTabBarOrderByWorktree: Record<string, string[]> = {
        ...s.tabBarOrderByWorktree
      }
      for (const wId of Object.keys(nextTabBarOrderByWorktree)) {
        const order = nextTabBarOrderByWorktree[wId]
        if (order?.includes(tabId)) {
          nextTabBarOrderByWorktree[wId] = order.filter((entryId) => entryId !== tabId)
        }
      }

      // Why: if the tab had a ptyId with unconsumed snapshot or cold restore
      // data (e.g., tab closed before TerminalPane mounted), clean it up to
      // prevent unbounded store growth across restarts.
      let nextSnapshots = s.pendingSnapshotByPtyId
      let nextColdRestores = s.pendingColdRestoreByPtyId
      if (closingPtyId) {
        if (closingPtyId in nextSnapshots) {
          nextSnapshots = { ...nextSnapshots }
          delete nextSnapshots[closingPtyId]
        }
        if (closingPtyId in nextColdRestores) {
          nextColdRestores = { ...nextColdRestores }
          delete nextColdRestores[closingPtyId]
        }
      }

      return {
        tabsByWorktree: next,
        activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
        activeTabIdByWorktree: nextActiveTabIdByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors the sibling pattern in tabs.ts.
        ...(nextUnreadTerminalTabs !== s.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {}),
        ...(nextUnreadTerminalPanes !== s.unreadTerminalPanes
          ? { unreadTerminalPanes: nextUnreadTerminalPanes }
          : {}),
        ...(nextUnreadAgentCompletionPanes !== s.unreadAgentCompletionPanes
          ? { unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes }
          : {}),
        lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey,
        expandedPaneByTabId: nextExpanded,
        canExpandPaneByTabId: nextCanExpand,
        terminalLayoutsByTabId: nextLayouts,
        pendingStartupByTabId: nextPendingStartupByTabId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        cacheTimerByKey: nextCacheTimer,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        pendingSnapshotByPtyId: nextSnapshots,
        pendingColdRestoreByPtyId: nextColdRestores
      }
    })
    // Why: sweep live AND retained agent-status entries for this tab — closing
    // the tab is the user telling us "I'm done with this session", so any
    // completion snapshots it left behind (in the inline agents list) must go
    // too. Use dropAgentStatusByTabPrefix (not removeAgentStatusByTabPrefix)
    // so retention suppressors are planted: a live→gone transition inside the
    // same frame as the tab close cannot re-snapshot a row we just dropped.
    get().dropAgentStatusByTabPrefix(tabId)
    for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
      const workspaceItem = tabs.find(
        (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
      )
      if (workspaceItem) {
        get().closeUnifiedTab(workspaceItem.id, opts)
      }
    }
  },

  reorderTabs: (worktreeId, tabIds) => {
    set((s) => {
      const tabs = s.tabsByWorktree[worktreeId] ?? []
      const tabMap = new Map(tabs.map((t) => [t.id, t]))
      const orderedSet = new Set(tabIds)
      const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))

      const reordered = [
        ...tabIds.map((id) => tabMap.get(id)!).filter(Boolean),
        ...missingTabs
      ].map((tab, i) => ({ ...tab, sortOrder: i }))

      return {
        tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: reordered }
      }
    })
  },

  setTabBarOrder: (worktreeId, order) => {
    set((s) => {
      // Update unified visual order
      const newTabBarOrder = { ...s.tabBarOrderByWorktree, [worktreeId]: order }

      // Keep terminal tab sortOrder in sync for persistence
      const tabs = s.tabsByWorktree[worktreeId]
      if (!tabs) {
        return { tabBarOrderByWorktree: newTabBarOrder }
      }
      const tabMap = new Map(tabs.map((t) => [t.id, t]))
      // Extract terminal IDs in their new relative order
      const terminalIdsInOrder = order.filter((id) => tabMap.has(id))
      const orderedSet = new Set(terminalIdsInOrder)
      const missingTabs = tabs.filter((t) => !orderedSet.has(t.id))

      const updatedTabs = [
        ...terminalIdsInOrder.map((id) => tabMap.get(id)!).filter(Boolean),
        ...missingTabs
      ].map((tab, i) => ({ ...tab, sortOrder: i }))

      return {
        tabBarOrderByWorktree: newTabBarOrder,
        tabsByWorktree: { ...s.tabsByWorktree, [worktreeId]: updatedTabs }
      }
    })
  },

  setActiveTab: (tabId) => {
    set((s) => {
      // Why: focusing a terminal tab clears the tab-level bell — the user has
      // moved to this tab.
      //
      // Why (activeWorktree guard below): only clear when the tab belongs to
      // the active worktree. If setActiveTab is invoked with a tab from a
      // background worktree (e.g., during worktree activation, or the
      // "jump to agent" path), the tab is not yet visible and clearing would
      // silently swallow the signal. Mirrors the guard in activateTab and
      // focusGroup.
      let tabOwnerWorktreeId: string | null = null
      for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
        if (tabs.some((t) => t.id === tabId)) {
          tabOwnerWorktreeId = wId
          break
        }
      }
      const nextUnreadTerminalTabs =
        tabOwnerWorktreeId === s.activeWorktreeId && s.unreadTerminalTabs[tabId]
          ? (() => {
              const copy = { ...s.unreadTerminalTabs }
              delete copy[tabId]
              return copy
            })()
          : s.unreadTerminalTabs
      // Why: only write the global activeTabId when the tab belongs to the
      // currently active worktree. markTerminalTabUnread treats activeTabId
      // as "the tab the user is looking at" and suppresses BELs on it; if we
      // pinned activeTabId to a background-worktree tab (e.g. the
      // jump-to-agent path calls setActiveTab before switching worktrees),
      // a subsequent BEL on that tab would be silently swallowed. The
      // per-worktree map still gets updated so the background worktree
      // remembers its last-active tab for later restoration. Mirrors the
      // pattern already used above for nextUnreadTerminalTabs.
      const isActiveWorktreeTab = tabOwnerWorktreeId === s.activeWorktreeId
      return {
        activeTabId: isActiveWorktreeTab ? tabId : s.activeTabId,
        activeTabIdByWorktree: tabOwnerWorktreeId
          ? { ...s.activeTabIdByWorktree, [tabOwnerWorktreeId]: tabId }
          : s.activeTabIdByWorktree,
        unreadTerminalTabs: nextUnreadTerminalTabs
      }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().activateTab(item.id)
    }
  },

  setActiveTabForWorktree: (worktreeId, tabId) => {
    set((s) => ({
      activeTabIdByWorktree: {
        ...s.activeTabIdByWorktree,
        [worktreeId]: tabId
      }
    }))
  },

  updateTabTitle: (tabId, title) => {
    set((s) => {
      // Why: locate the owning worktree and mutate only that entry in
      // tabsByWorktree. Rebuilding every worktree's tab array (even when
      // unchanged) would break shallow-equality checks in unrelated
      // selectors and trigger spurious re-renders across background
      // worktrees on every OSC title frame.
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
      if (!ownerWorktreeId) {
        return s
      }
      const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
      const tabIndex = tabs.findIndex((t) => t.id === tabId)
      const currentTab = tabs[tabIndex]
      if (!currentTab) {
        return s
      }
      const nextTitle = title.trim() || getFallbackTabTitle(currentTab)
      const currentUnifiedTabs = s.unifiedTabsByWorktree[ownerWorktreeId] ?? []
      if (isDecorativeAgentTitleFrameChange(currentTab.title, nextTitle)) {
        const unifiedTabsWithCurrentLabel = updateUnifiedTerminalLabel(
          currentUnifiedTabs,
          tabId,
          currentTab.title
        )
        return unifiedTabsWithCurrentLabel
          ? {
              unifiedTabsByWorktree: {
                ...s.unifiedTabsByWorktree,
                [ownerWorktreeId]: unifiedTabsWithCurrentLabel
              }
            }
          : s
      }
      const unifiedTabsWithUpdatedLabel = updateUnifiedTerminalLabel(
        currentUnifiedTabs,
        tabId,
        nextTitle
      )
      if (currentTab.title === nextTitle) {
        return unifiedTabsWithUpdatedLabel
          ? {
              unifiedTabsByWorktree: {
                ...s.unifiedTabsByWorktree,
                [ownerWorktreeId]: unifiedTabsWithUpdatedLabel
              }
            }
          : s
      }
      const ownerTabs = tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              // Why: PTYs can briefly emit an empty title while an agent exits.
              // Keep the stable fallback label instead of rendering a blank tab.
              title: nextTitle,
              defaultTitle:
                tab.defaultTitle ??
                (/^Terminal \d+$/.test(tab.title) ? tab.title : undefined) ??
                (/^Terminal \d+$/.test(nextTitle) ? nextTitle : undefined)
            }
          : tab
      )
      scheduleRuntimeGraphSync()
      const nextTabsByWorktree = { ...s.tabsByWorktree, [ownerWorktreeId]: ownerTabs }
      // Agent status is derived from terminal titles and affects sort scoring,
      // so a title change is a meaningful event that should allow re-sort —
      // but only for background worktrees. Title changes in the active
      // worktree are side-effects of PTY reconnection during worktree
      // activation (generation bump → TerminalPane remount → new shell →
      // title update). Bumping sortEpoch here would reorder the sidebar
      // on click — the exact bug PR #209 intended to fix.
      const isActive = ownerWorktreeId === s.activeWorktreeId
      const nextState: Partial<AppState> = isActive
        ? { tabsByWorktree: nextTabsByWorktree }
        : { tabsByWorktree: nextTabsByWorktree, sortEpoch: s.sortEpoch + 1 }
      if (unifiedTabsWithUpdatedLabel) {
        nextState.unifiedTabsByWorktree = {
          ...s.unifiedTabsByWorktree,
          [ownerWorktreeId]: unifiedTabsWithUpdatedLabel
        }
      }
      return nextState
    })
  },

  setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt) => {
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || prompt.length === 0) {
      return
    }
    set((s) => {
      if (s.settings?.tabAutoGenerateTitle !== true) {
        return s
      }
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
      if (!ownerWorktreeId) {
        return s
      }
      const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
      const tabIndex = tabs.findIndex((tab) => tab.id === tabId)
      const currentTab = tabs[tabIndex]
      if (
        !currentTab ||
        currentTab.customTitle?.trim() ||
        currentTab.quickCommandLabel?.trim() ||
        currentTab.generatedTitle?.trim()
      ) {
        return s
      }
      const generatedTitle = deriveGeneratedTabTitle(prompt)
      if (!generatedTitle) {
        return s
      }
      const ownerTabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, generatedTitle } : tab))
      const currentUnifiedTabs = s.unifiedTabsByWorktree[ownerWorktreeId] ?? []
      const unifiedTabsWithGeneratedLabel = updateUnifiedTerminalGeneratedLabel(
        currentUnifiedTabs,
        tabId,
        generatedTitle
      )
      scheduleRuntimeGraphSync()
      return {
        tabsByWorktree: {
          ...s.tabsByWorktree,
          [ownerWorktreeId]: ownerTabs
        },
        ...(unifiedTabsWithGeneratedLabel
          ? {
              unifiedTabsByWorktree: {
                ...s.unifiedTabsByWorktree,
                [ownerWorktreeId]: unifiedTabsWithGeneratedLabel
              }
            }
          : {})
      }
    })
  },

  clearTabLaunchAgent: (tabId) => {
    set((s) => {
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
      if (!ownerWorktreeId) {
        return s
      }
      const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
      const tabIndex = tabs.findIndex((t) => t.id === tabId)
      const currentTab = tabs[tabIndex]
      if (!currentTab?.launchAgent) {
        return s
      }
      const { launchAgent: _launchAgent, ...tabWithoutLaunchAgent } = currentTab
      void _launchAgent
      const nextTabs = [...tabs]
      nextTabs[tabIndex] = tabWithoutLaunchAgent
      scheduleRuntimeGraphSync()
      return { tabsByWorktree: { ...s.tabsByWorktree, [ownerWorktreeId]: nextTabs } }
    })
  },

  setRuntimePaneTitle: (tabId, paneId, title) => {
    set((s) => {
      const currentByPane = s.runtimePaneTitlesByTabId[tabId] ?? {}
      const prevTitle = currentByPane[paneId]
      if (prevTitle === title) {
        return s
      }
      if (prevTitle && isDecorativeAgentTitleFrameChange(prevTitle, title)) {
        return s
      }
      // Why: smart sort's title-heuristic fallback (Edge case 9) reads
      // runtimePaneTitlesByTabId. A hookless agent transitioning from
      // 'working' → 'permission' via a title change must trigger a re-sort,
      // otherwise the worktree stays in its old class until some unrelated
      // event fires. Bumping only on classification change keeps incidental
      // title noise (spinner frame, prompt suffix) from churning the sidebar.
      const classificationChanged =
        detectAgentStatusFromTitle(prevTitle ?? '') !== detectAgentStatusFromTitle(title)
      // Why: locate the owning worktree so we can suppress the sortEpoch
      // bump when the changing pane lives in the active worktree. Title
      // changes there are side-effects of the user's click (PTY remount on
      // worktree activation emits a fresh shell prompt, then the agent
      // re-emits its working title) — bumping would re-rank the sidebar on
      // click, the exact bug PR #209 fixed for updateTabTitle. If no owner
      // is found the pane is orphaned; skip the bump as unsafe.
      const ownerWorktreeId = classificationChanged
        ? getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        : null
      const isActive = ownerWorktreeId !== null && ownerWorktreeId === s.activeWorktreeId
      const shouldBump = classificationChanged && ownerWorktreeId !== null && !isActive
      return {
        runtimePaneTitlesByTabId: {
          ...s.runtimePaneTitlesByTabId,
          [tabId]: { ...currentByPane, [paneId]: title }
        },
        ...(shouldBump ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })
  },

  clearRuntimePaneTitle: (tabId, paneId) => {
    set((s) => {
      const currentByPane = s.runtimePaneTitlesByTabId[tabId]
      if (!currentByPane || !(paneId in currentByPane)) {
        return s
      }
      const prevTitle = currentByPane[paneId]
      const nextByPane = { ...currentByPane }
      delete nextByPane[paneId]

      const next = { ...s.runtimePaneTitlesByTabId }
      if (Object.keys(nextByPane).length > 0) {
        next[tabId] = nextByPane
      } else {
        delete next[tabId]
      }

      // Why: clearing a 'working'/'permission'-classified title back to none
      // changes the title-heuristic verdict for that pane, so the smart sort
      // needs a re-sort. See setRuntimePaneTitle for the rationale.
      const hadClassification = detectAgentStatusFromTitle(prevTitle ?? '') !== null
      // Why: same active-worktree gate as setRuntimePaneTitle — clears that
      // fire as a side-effect of a click-driven PTY teardown in the active
      // worktree must not re-rank the sidebar. Skip bumping when no owner is
      // found (orphaned pane) for the same safety reason.
      const ownerWorktreeId = hadClassification
        ? getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
        : null
      const isActive = ownerWorktreeId !== null && ownerWorktreeId === s.activeWorktreeId
      const shouldBump = hadClassification && ownerWorktreeId !== null && !isActive
      return {
        runtimePaneTitlesByTabId: next,
        ...(shouldBump ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })
  },

  markTerminalTabUnread: (tabId) => {
    const state = get()
    const ownerTab = Object.values(state.tabsByWorktree ?? {})
      .flat()
      .find((t) => t.id === tabId)
    if (!ownerTab) {
      return
    }
    // Why: terminal attention must stay visible until interaction ("show
    // until interact"). A signal on the focused tab still sets the indicator;
    // real user interaction with the pane dismisses it. Keystroke/pointerdown
    // routes through clearTerminalTabUnread (see pty-connection.ts and
    // TerminalPane.tsx); tab/group activation clears unreadTerminalTabs
    // directly in activateTab/focusGroup as a pre-existing side-effect.
    set((s) => {
      if (s.unreadTerminalTabs[tabId]) {
        return s
      }
      return { unreadTerminalTabs: { ...s.unreadTerminalTabs, [tabId]: true as const } }
    })
  },

  markTerminalPaneUnread: (paneKey) => {
    set((s) => {
      if (s.unreadTerminalPanes[paneKey]) {
        return s
      }
      return { unreadTerminalPanes: { ...s.unreadTerminalPanes, [paneKey]: true as const } }
    })
  },

  markAgentCompletionPaneUnread: (paneKey) => {
    set((s) => {
      if (s.unreadAgentCompletionPanes[paneKey]) {
        return s
      }
      return {
        unreadAgentCompletionPanes: {
          ...s.unreadAgentCompletionPanes,
          [paneKey]: true as const
        }
      }
    })
  },

  clearTerminalTabUnread: (tabId) => {
    set((s) => {
      if (!s.unreadTerminalTabs[tabId]) {
        return s
      }
      const copy = { ...s.unreadTerminalTabs }
      delete copy[tabId]
      return { unreadTerminalTabs: copy }
    })
  },

  clearTerminalPaneUnread: (paneKey) => {
    set((s) => {
      if (!s.unreadTerminalPanes[paneKey] && !s.unreadAgentCompletionPanes[paneKey]) {
        return s
      }
      const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
      const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
      delete nextUnreadTerminalPanes[paneKey]
      delete nextUnreadAgentCompletionPanes[paneKey]
      return {
        unreadTerminalPanes: nextUnreadTerminalPanes,
        unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes
      }
    })
  },

  setTabCustomTitle: (tabId, title, opts) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, customTitle: title } : t))
      }
      scheduleRuntimeGraphSync()
      return { tabsByWorktree: next }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().setTabCustomLabel(item.id, title, opts)
    }
  },

  setTabColor: (tabId, color) => {
    set((s) => {
      const next = { ...s.tabsByWorktree }
      for (const wId of Object.keys(next)) {
        next[wId] = next[wId].map((t) => (t.id === tabId ? { ...t, color } : t))
      }
      return { tabsByWorktree: next }
    })
    const item = Object.values(get().unifiedTabsByWorktree)
      .flat()
      .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      get().setUnifiedTabColor(item.id, color)
      // Why: tab color is host-authoritative for remote-server tabs; mirror it
      // so it persists instead of reverting on the next snapshot.
      const state = get()
      const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((wId) =>
        (state.unifiedTabsByWorktree[wId] ?? []).some((entry) => entry.id === item.id)
      )
      if (owningWorktreeId && getRuntimeEnvironmentIdForWorktree(state, owningWorktreeId)) {
        void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
          setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
        )
      }
    }
  },

  updateTabPtyId: (tabId, ptyId) => {
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    const isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      const nextPtyIds = existingPtyIds.includes(ptyId)
        ? existingPtyIds
        : [...existingPtyIds, ptyId]
      let nextTabsByWorktree = s.tabsByWorktree
      for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
        const index = tabs.findIndex((t) => t.id === tabId)
        if (index === -1) {
          continue
        }
        worktreeId = wId
        const tab = tabs[index]
        if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
          wasActivationSpawn = true
        }
        // Why: consume one pendingActivationSpawn unit here. Split layouts can
        // remount several panes for one click, and each pane's activation-time
        // PTY callback must be suppressed without hiding later real activity.
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        // Why: tab.ptyId is the single-pane fallback used by legacy attach
        // paths. In split panes, later pane spawns must not steal that
        // primary binding from the original pane or remount/close flows can
        // reattach the tab to the wrong PTY and appear to "reset" panes.
        const nextTabPtyId = tab.ptyId ?? nextPtyIds[0] ?? null
        const nextPendingActivationSpawn = consumePendingActivationSpawn(tab.pendingActivationSpawn)
        if (tab.pendingActivationSpawn || tab.ptyId !== nextTabPtyId) {
          const nextTabs = [...tabs]
          nextTabs[index] = {
            ...rest,
            ...(nextPendingActivationSpawn
              ? { pendingActivationSpawn: nextPendingActivationSpawn }
              : {}),
            ptyId: nextTabPtyId
          }
          nextTabsByWorktree = { ...s.tabsByWorktree, [wId]: nextTabs }
        }
        break
      }
      // Why: when a brand-new tab in the active worktree receives its first
      // PTY, the live-tab signal (+12) flips on. Normally we bump sortEpoch
      // here so the sort reflects the new signal immediately. Suppress the
      // bump on activation-driven spawns because they are side-effects of the
      // user clicking on a worktree, not real activity — otherwise clicking a
      // dormant worktree would always trigger a re-sort.
      const isFirstPty = existingPtyIds.length === 0
      const isActiveWorktree = worktreeId != null && s.activeWorktreeId === worktreeId
      const shouldBumpSortEpoch = isFirstPty && isActiveWorktree && !wasActivationSpawn
      const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
      delete nextSuppressedPtyExitIds[ptyId]
      const remoteRuntimePtyHandle = parseRemoteRuntimePtyId(ptyId)?.handle
      if (remoteRuntimePtyHandle) {
        delete nextSuppressedPtyExitIds[remoteRuntimePtyHandle]
      }
      return {
        ...(nextTabsByWorktree !== s.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [tabId]: nextPtyIds
        },
        lastKnownRelayPtyIdByTabId: {
          ...s.lastKnownRelayPtyIdByTabId,
          [tabId]: ptyId
        },
        suppressedPtyExitIds: nextSuppressedPtyExitIds,
        ...(shouldBumpSortEpoch ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })

    // Why: activation-driven spawns are caused by the user clicking a
    // worktree, not by work happening in it. Skip both the lastActivityAt
    // stamp and the sortEpoch bump so the sidebar does not reorder on click.
    // Other spawn reasons (new tab, codex restart, reconnect) still flow
    // through bumpWorktreeActivity as a normal activity signal.
    if (worktreeId && !wasActivationSpawn && !isRemoteRuntimeMirror) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  clearTabPtyId: (tabId, ptyId) => {
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    let isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      const remainingPtyIds = ptyId ? existingPtyIds.filter((id) => id !== ptyId) : []
      let nextTabsByWorktree = s.tabsByWorktree
      for (const [wId, tabs] of Object.entries(s.tabsByWorktree)) {
        const index = tabs.findIndex((t) => t.id === tabId)
        if (index === -1) {
          continue
        }
        worktreeId = wId
        const tab = tabs[index]
        if (getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0) {
          wasActivationSpawn = true
        }
        if (!ptyId) {
          isRemoteRuntimeMirror =
            existingPtyIds.length > 0 && existingPtyIds.every((id) => isRemoteRuntimePtyId(id))
        }
        // Why: consume pendingActivationSpawn for real activation-time clears,
        // but keep it when clearing a stale wake-hint id that was not live in
        // ptyIdsByTabId. That path immediately falls back to a fresh spawn,
        // and the spawn still needs the click-driven suppression.
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        const nextTabPtyId = remainingPtyIds.at(-1) ?? null
        const shouldRetainActivationSpawn =
          wasActivationSpawn && ptyId != null && !existingPtyIds.includes(ptyId)
        const nextPendingActivationSpawn = shouldRetainActivationSpawn
          ? tab.pendingActivationSpawn
          : consumePendingActivationSpawn(tab.pendingActivationSpawn)
        if (tab.pendingActivationSpawn || tab.ptyId !== nextTabPtyId) {
          const nextTabs = [...tabs]
          nextTabs[index] = {
            ...rest,
            ...(nextPendingActivationSpawn
              ? { pendingActivationSpawn: nextPendingActivationSpawn }
              : {}),
            ptyId: nextTabPtyId
          }
          nextTabsByWorktree = { ...s.tabsByWorktree, [wId]: nextTabs }
        }
        break
      }
      const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
      nextPtyIdsByTabId[tabId] = remainingPtyIds
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      if (ptyId) {
        delete nextPendingCodexPaneRestartIds[ptyId]
        delete nextCodexRestartNoticeByPtyId[ptyId]
      } else {
        for (const currentPtyId of s.ptyIdsByTabId[tabId] ?? []) {
          delete nextPendingCodexPaneRestartIds[currentPtyId]
          delete nextCodexRestartNoticeByPtyId[currentPtyId]
        }
      }
      // Why: when a specific ptyId is passed, the PTY actually exited (not
      // just disconnected). Remove its lastKnown entry so session-save does
      // not attempt to reattach a dead relay PTY on next restart. When no
      // ptyId is passed (bulk clear on connection_lost), preserve lastKnown
      // because the relay still has the PTY alive during its grace period.
      const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
      if (ptyId && nextLastKnownRelay[tabId] === ptyId) {
        delete nextLastKnownRelay[tabId]
      }

      return {
        ...(nextTabsByWorktree !== s.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
      }
    })

    // Bump meaningful activity when a PTY exits, but skip if this exit
    // was triggered by an intentional shutdown (suppressed exits) OR by a
    // click-driven pane unmount (pendingActivationSpawn).
    if (
      worktreeId &&
      !wasActivationSpawn &&
      !isRemoteRuntimeMirror &&
      !hasWorktreeSleepIntent(worktreeId) &&
      !(ptyId && get().suppressedPtyExitIds[ptyId])
    ) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  shutdownCompletedAgentPaneForHibernation: async (worktreeId, opts) => {
    const paneKeys = [opts.paneKey]
    const expectedRuntimePtyIds = sortedUniquePtyIds(
      opts.expectedRuntimePtyId ? [opts.expectedRuntimePtyId] : []
    )
    const shutdownPtyIds = sortedUniquePtyIds([opts.ptyId, ...expectedRuntimePtyIds])
    const state = get()
    const tab = (state.tabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === opts.tabId
    )
    const parsed = parsePaneKey(opts.paneKey)
    const layout = state.terminalLayoutsByTabId[opts.tabId]
    const liveTabPtyIds = state.ptyIdsByTabId[opts.tabId] ?? []
    if (
      !tab ||
      !parsed ||
      parsed.tabId !== opts.tabId ||
      parsed.leafId !== opts.leafId ||
      layout?.ptyIdsByLeafId?.[opts.leafId] !== opts.ptyId ||
      (expectedRuntimePtyIds.length === 0 && !liveTabPtyIds.includes(opts.ptyId))
    ) {
      throw new Error('agent_hibernation_pane_binding_mismatch')
    }

    const sleepingAgentSessionRecords = collectSleepingAgentSessionRecordsForWorktree(
      state,
      worktreeId,
      paneKeys
    )
    const retainedCompletionEvidence = collectHibernatedCompletionEvidenceForWorktree(
      state,
      worktreeId,
      paneKeys
    )

    const capture = shutdownBufferCaptures.get(opts.tabId)
    if (capture) {
      try {
        capture({ includeLocalBuffers: false })
      } catch {
        // Don't let one tab's capture failure block the pane hibernation.
      }
    }

    const clearTargetSuppressions = (): void => {
      set((s) => {
        const next = { ...s.suppressedPtyExitIds }
        for (const ptyId of shutdownPtyIds) {
          delete next[ptyId]
        }
        return { suppressedPtyExitIds: next }
      })
    }

    set((s) => ({
      suppressedPtyExitIds: {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(shutdownPtyIds.map((ptyId) => [ptyId, true] as const))
      }
    }))

    if (expectedRuntimePtyIds.length > 0) {
      const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(get(), worktreeId)
      if (!runtimeEnvironmentId) {
        clearTargetSuppressions()
        throw new Error('missing_runtime_for_exact_terminal_stop')
      }
      let stopResult: {
        stoppedPtyIds?: string[]
        livePtyIds?: string[]
        postStopVerified?: boolean
        postStopFailure?: string
      }
      try {
        stopResult = await callRuntimeRpc<{
          stoppedPtyIds?: string[]
          livePtyIds?: string[]
          postStopVerified?: boolean
          postStopFailure?: string
        }>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.stopExact',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            expectedPtyIds: expectedRuntimePtyIds,
            keepHistory: true,
            targetOnly: true
          },
          { timeoutMs: 15_000 }
        )
      } catch (err) {
        clearTargetSuppressions()
        throw err
      }
      const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
      const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
      const targetWasLive = expectedRuntimePtyIds.every((ptyId) => livePtyIds.includes(ptyId))
      if (!equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) || !targetWasLive) {
        clearTargetSuppressions()
        throw new Error('exact_terminal_stop_mismatch')
      }
      if (stopResult.postStopVerified !== true) {
        clearTargetSuppressions()
        throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
      }
      unregisterPtyDataHandlers(shutdownPtyIds)
    } else if (!opts.ptyId.startsWith('remote:')) {
      // Why: pty.kill can flush final data before exit; unregister first so
      // pane hibernation cannot fire phantom notifications from stale handlers.
      const handlerSnapshots = unregisterPtyDataHandlers(shutdownPtyIds)
      try {
        await window.api.pty.kill(opts.ptyId, { keepHistory: true })
      } catch (err) {
        restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
        clearTargetSuppressions()
        throw err
      }
    }

    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[opts.tabId] ?? []
      const shutdownPtyIdSet = new Set(shutdownPtyIds)
      const remainingPtyIds = existingPtyIds.filter((ptyId) => !shutdownPtyIdSet.has(ptyId))
      const nextTabsByWorktree = { ...s.tabsByWorktree }
      const tabs = nextTabsByWorktree[worktreeId] ?? []
      const tabIndex = tabs.findIndex((candidate) => candidate.id === opts.tabId)
      if (tabIndex !== -1) {
        const nextTabs = [...tabs]
        nextTabs[tabIndex] = {
          ...nextTabs[tabIndex],
          ptyId: remainingPtyIds.at(-1) ?? null
        }
        nextTabsByWorktree[worktreeId] = nextTabs
      }

      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of shutdownPtyIds) {
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      const nextLastKnownRelay =
        remainingPtyIds.length === 0
          ? { ...s.lastKnownRelayPtyIdByTabId }
          : s.lastKnownRelayPtyIdByTabId
      if (remainingPtyIds.length === 0) {
        delete nextLastKnownRelay[opts.tabId]
      }

      let nextRuntimePaneTitlesByTabId = s.runtimePaneTitlesByTabId
      const numericPaneId = Number(opts.leafId)
      if (
        Number.isInteger(numericPaneId) &&
        s.runtimePaneTitlesByTabId[opts.tabId]?.[numericPaneId]
      ) {
        const nextByPane = { ...s.runtimePaneTitlesByTabId[opts.tabId] }
        delete nextByPane[numericPaneId]
        nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
        if (Object.keys(nextByPane).length > 0) {
          nextRuntimePaneTitlesByTabId[opts.tabId] = nextByPane
        } else {
          delete nextRuntimePaneTitlesByTabId[opts.tabId]
        }
      }

      const nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
      const nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
      const nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
      delete nextUnreadTerminalPanes[opts.paneKey]
      delete nextUnreadAgentCompletionPanes[opts.paneKey]
      delete nextLastTerminalInputAtByPaneKey[opts.paneKey]

      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: {
          ...s.ptyIdsByTabId,
          [opts.tabId]: remainingPtyIds
        },
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(shutdownPtyIds.map((ptyId) => [ptyId, true] as const))
        },
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        ...(nextRuntimePaneTitlesByTabId !== s.runtimePaneTitlesByTabId
          ? { runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId }
          : {}),
        unreadTerminalPanes: nextUnreadTerminalPanes,
        unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes,
        lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey
      }
    })

    set((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        ...sleepingAgentSessionRecords
      }
    }))

    get().dropHibernatedAgentStatusPane(worktreeId, opts.paneKey, {
      retainedCompletionEvidence
    })
  },

  shutdownWorktreeTerminals: async (worktreeId, opts) => {
    const keepIdentifiers = opts?.keepIdentifiers ?? false
    const shutdownReason: AgentStatusWorktreeShutdownReason =
      opts?.shutdownReason ?? (keepIdentifiers ? 'manual-sleep' : 'remove-worktree')
    const tabs = get().tabsByWorktree[worktreeId] ?? []
    const ptyIds = tabs.flatMap((tab) => get().ptyIdsByTabId[tab.id] ?? [])
    const expectedRuntimePtyIds = sortedUniquePtyIds(opts?.expectedRuntimePtyIds)
    const shutdownPtyIds = sortedUniquePtyIds([...ptyIds, ...expectedRuntimePtyIds])
    const sleepingAgentSessionRecords = keepIdentifiers
      ? collectSleepingAgentSessionRecordsForWorktree(get(), worktreeId, opts?.sleepingPaneKeys)
      : {}
    const retainedCompletionEvidence =
      shutdownReason === 'auto-hibernate-completed-agent'
        ? collectHibernatedCompletionEvidenceForWorktree(get(), worktreeId, opts?.sleepingPaneKeys)
        : []

    // Why: the main process flushes any remaining batched PTY data before
    // sending the exit event (pty.ts onExit handler). Without this, that
    // final data burst flows through the still-registered ptyDataHandlers
    // where bell detection and agent-status tracking can fire system
    // notifications for a worktree that is already being torn down —
    // the "phantom alerts" users see after shutting down worktrees.
    // Removing the data handlers first ensures the final flush is a no-op.
    if (expectedRuntimePtyIds.length === 0) {
      unregisterPtyDataHandlers(shutdownPtyIds)
    }

    // Why (ordering invariant — DESIGN_DOC §3.3.c): on sleep, capture every
    // pane's serializer buffer into terminalLayoutsByTabId[tab].buffersByLeafId
    // BEFORE issuing pty.kill (panes unmount on PTY exit and their
    // serializeAddons go with them) AND BEFORE the set() block below (the
    // capture writes through to the store via its own setTabLayout call; any
    // subsequent set must use a functional updater spreading
    // s.terminalLayoutsByTabId, not a captured snapshot). For SSH this is
    // load-bearing — the relay drops the remote PTY on kill so there's no
    // on-disk history dir to cold-restore from. Local daemon scrollback is
    // intentionally skipped because the session payload prunes it and daemon
    // history/checkpoints are authoritative.
    if (keepIdentifiers) {
      for (const tab of tabs) {
        const capture = shutdownBufferCaptures.get(tab.id)
        if (capture) {
          try {
            capture({ includeLocalBuffers: false })
          } catch {
            // Don't let one tab's capture failure block the rest.
          }
        }
      }
    }

    const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(get(), worktreeId)
    if (expectedRuntimePtyIds.length > 0) {
      if (!runtimeEnvironmentId) {
        throw new Error('missing_runtime_for_exact_terminal_stop')
      }
      set((s) => ({
        suppressedPtyExitIds: {
          ...s.suppressedPtyExitIds,
          ...Object.fromEntries(shutdownPtyIds.map((ptyId) => [ptyId, true] as const))
        }
      }))
      let stopResult: {
        stoppedPtyIds?: string[]
        livePtyIds?: string[]
        postStopVerified?: boolean
        postStopFailure?: string
        remainingLivePtyIds?: string[]
      }
      try {
        stopResult = await callRuntimeRpc<{
          stoppedPtyIds?: string[]
          livePtyIds?: string[]
        }>(
          { kind: 'environment', environmentId: runtimeEnvironmentId },
          'terminal.stopExact',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            expectedPtyIds: expectedRuntimePtyIds,
            keepHistory: keepIdentifiers
          },
          { timeoutMs: 15_000 }
        )
      } catch (err) {
        set((s) => {
          const next = { ...s.suppressedPtyExitIds }
          for (const ptyId of shutdownPtyIds) {
            delete next[ptyId]
          }
          return { suppressedPtyExitIds: next }
        })
        throw err
      }
      const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
      const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
      if (
        !equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) ||
        !equalStringSets(livePtyIds, expectedRuntimePtyIds)
      ) {
        set((s) => {
          const next = { ...s.suppressedPtyExitIds }
          for (const ptyId of shutdownPtyIds) {
            delete next[ptyId]
          }
          return { suppressedPtyExitIds: next }
        })
        throw new Error('exact_terminal_stop_mismatch')
      }
      if (stopResult.postStopVerified !== true) {
        set((s) => {
          const next = { ...s.suppressedPtyExitIds }
          for (const ptyId of shutdownPtyIds) {
            delete next[ptyId]
          }
          return { suppressedPtyExitIds: next }
        })
        throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
      }
      unregisterPtyDataHandlers(shutdownPtyIds)
    }

    set((s) => {
      const nextTabsByWorktree = keepIdentifiers
        ? s.tabsByWorktree
        : {
            ...s.tabsByWorktree,
            [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((tab, index) =>
              clearTransientTerminalState(tab, index)
            )
          }
      const nextPtyIdsByTabId = {
        ...s.ptyIdsByTabId,
        ...Object.fromEntries(tabs.map((tab) => [tab.id, [] as string[]] as const))
      }
      const nextRuntimePaneTitlesByTabId = keepIdentifiers
        ? s.runtimePaneTitlesByTabId
        : { ...s.runtimePaneTitlesByTabId }
      const nextSuppressedPtyExitIds = {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(shutdownPtyIds.map((ptyId) => [ptyId, true] as const))
      }
      // Why: pendingCodexPaneRestartIds is keyed by ptyId — under sleep we
      // preserve it so a mid-restart marker survives wake against the same
      // identifier. codexRestartNoticeByPtyId is also keyed by the now-stale
      // ptyId; on wake the post-spawn ptyId may differ, so the notice can't
      // be carried forward and is cleared in both cases.
      const nextPendingCodexPaneRestartIds = keepIdentifiers
        ? s.pendingCodexPaneRestartIds
        : { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of shutdownPtyIds) {
        if (!keepIdentifiers) {
          delete nextPendingCodexPaneRestartIds[ptyId]
        }
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      // Why: setup-split and issue-command-split are transient one-shots that
      // drive new-tab UX. They are not sleep-recovery state; clear in both
      // cases.
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      // Why: under remove-worktree (default), layout snapshots carry
      // `ptyIdsByLeafId` referencing now-dead PTY IDs; if we leave them, the
      // next remount takes the reattach branch in connectPanePty and produces
      // a visible but non-interactive "zombie" pane. Under sleep
      // (keepIdentifiers), we preserve `ptyIdsByLeafId` precisely so wake can
      // pass them as args.sessionId to pty.spawn and reattach to the daemon
      // history dir (or, on SSH, restore scrollback from buffersByLeafId
      // captured above).
      const nextTerminalLayoutsByTabId = { ...s.terminalLayoutsByTabId }
      // Why: unread dots survive across worktree switches by design, but a
      // full shutdown tears down the PTYs behind them. Even under sleep, the
      // PTYs are killed, so unread state pointing at dead ptyIds is stale —
      // clear in both cases. (Carrying the dot across sleep would also be
      // surprising and inconsistent with how it behaves on tab close.)
      // Why: preserve the unreadTerminalTabs reference when none of the
      // shutting-down tabs had an unread flag — avoids a no-op top-level
      // state allocation that would force re-evaluation of full-state
      // selectors on unrelated shutdown calls. Mirrors the sibling pattern
      // in tabs.ts.
      let nextUnreadTerminalTabs = s.unreadTerminalTabs
      let nextUnreadTerminalPanes = s.unreadTerminalPanes
      let nextUnreadAgentCompletionPanes = s.unreadAgentCompletionPanes
      let nextLastTerminalInputAtByPaneKey = s.lastTerminalInputAtByPaneKey
      for (const tab of tabs) {
        if (!keepIdentifiers) {
          delete nextRuntimePaneTitlesByTabId[tab.id]
        }
        delete nextPendingSetupSplitByTabId[tab.id]
        delete nextPendingIssueCommandSplitByTabId[tab.id]
        if (nextUnreadTerminalTabs[tab.id]) {
          if (nextUnreadTerminalTabs === s.unreadTerminalTabs) {
            nextUnreadTerminalTabs = { ...s.unreadTerminalTabs }
          }
          delete nextUnreadTerminalTabs[tab.id]
        }
        for (const paneKey of Object.keys(nextUnreadTerminalPanes)) {
          if (paneKey.startsWith(`${tab.id}:`)) {
            if (nextUnreadTerminalPanes === s.unreadTerminalPanes) {
              nextUnreadTerminalPanes = { ...s.unreadTerminalPanes }
            }
            delete nextUnreadTerminalPanes[paneKey]
          }
        }
        for (const paneKey of Object.keys(nextUnreadAgentCompletionPanes)) {
          if (paneKey.startsWith(`${tab.id}:`)) {
            if (nextUnreadAgentCompletionPanes === s.unreadAgentCompletionPanes) {
              nextUnreadAgentCompletionPanes = { ...s.unreadAgentCompletionPanes }
            }
            delete nextUnreadAgentCompletionPanes[paneKey]
          }
        }
        for (const paneKey of Object.keys(nextLastTerminalInputAtByPaneKey)) {
          if (paneKey.startsWith(`${tab.id}:`)) {
            if (nextLastTerminalInputAtByPaneKey === s.lastTerminalInputAtByPaneKey) {
              nextLastTerminalInputAtByPaneKey = { ...s.lastTerminalInputAtByPaneKey }
            }
            delete nextLastTerminalInputAtByPaneKey[paneKey]
          }
        }
        if (!keepIdentifiers) {
          const existingLayout = nextTerminalLayoutsByTabId[tab.id]
          if (existingLayout?.ptyIdsByLeafId) {
            nextTerminalLayoutsByTabId[tab.id] = {
              ...existingLayout,
              ptyIdsByLeafId: {}
            }
          }
        }
      }

      // Why: under remove-worktree, intentional shutdown kills the relay PTY
      // and persisting a dead session ID would cause next-restart reattach to
      // fail. Under sleep, wake re-spawns over the relay against this exact
      // session ID — preserving it is what lets the wake-side wiring stay
      // consistent.
      const nextLastKnownRelay = keepIdentifiers
        ? s.lastKnownRelayPtyIdByTabId
        : { ...s.lastKnownRelayPtyIdByTabId }
      if (!keepIdentifiers) {
        for (const tab of tabs) {
          delete nextLastKnownRelay[tab.id]
        }
      }

      return {
        tabsByWorktree: nextTabsByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        suppressedPtyExitIds: nextSuppressedPtyExitIds,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        terminalLayoutsByTabId: nextTerminalLayoutsByTabId,
        // Why: skip writing unreadTerminalTabs when the reference is unchanged —
        // avoids a no-op top-level state allocation that would force re-evaluation
        // of full-state selectors. Mirrors the sibling pattern in tabs.ts.
        ...(nextUnreadTerminalTabs !== s.unreadTerminalTabs
          ? { unreadTerminalTabs: nextUnreadTerminalTabs }
          : {}),
        ...(nextUnreadTerminalPanes !== s.unreadTerminalPanes
          ? { unreadTerminalPanes: nextUnreadTerminalPanes }
          : {}),
        ...(nextUnreadAgentCompletionPanes !== s.unreadAgentCompletionPanes
          ? { unreadAgentCompletionPanes: nextUnreadAgentCompletionPanes }
          : {}),
        ...(nextLastTerminalInputAtByPaneKey !== s.lastTerminalInputAtByPaneKey
          ? { lastTerminalInputAtByPaneKey: nextLastTerminalInputAtByPaneKey }
          : {})
      }
    })

    if (keepIdentifiers) {
      set((s) => ({
        sleepingAgentSessionsByPaneKey: {
          ...s.sleepingAgentSessionsByPaneKey,
          ...sleepingAgentSessionRecords
        }
      }))
    } else {
      get().clearSleepingAgentSessionsByWorktree(worktreeId)
    }

    // Why: only automatic completed-agent sleep keeps passive completion
    // evidence; manual sleep/remove still fold the entire worktree surface.
    get().dropAgentStatusByWorktree(worktreeId, {
      shutdownReason,
      sleepingPaneKeys: opts?.sleepingPaneKeys,
      retainedCompletionEvidence
    })

    if (ptyIds.length === 0 && expectedRuntimePtyIds.length === 0) {
      return
    }

    if (runtimeEnvironmentId && expectedRuntimePtyIds.length === 0) {
      await callRuntimeRpc(
        { kind: 'environment', environmentId: runtimeEnvironmentId },
        'terminal.stop',
        { worktree: toRuntimeWorktreeSelector(worktreeId) },
        { timeoutMs: 15_000 }
      ).catch(() => null)
    }

    await Promise.allSettled(
      ptyIds
        .filter((ptyId) => !expectedRuntimePtyIds.includes(ptyId))
        .filter((ptyId) => !ptyId.startsWith('remote:'))
        .map((ptyId) => window.api.pty.kill(ptyId, { keepHistory: keepIdentifiers }))
    )
  },

  consumeSuppressedPtyExit: (ptyId) => {
    let wasSuppressed = false
    set((s) => {
      if (!s.suppressedPtyExitIds[ptyId]) {
        return {}
      }
      wasSuppressed = true
      const next = { ...s.suppressedPtyExitIds }
      delete next[ptyId]
      return { suppressedPtyExitIds: next }
    })
    return wasSuppressed
  },

  suppressPtyExit: (ptyId) => {
    set((s) => ({
      suppressedPtyExitIds: { ...s.suppressedPtyExitIds, [ptyId]: true }
    }))
  },

  queueCodexPaneRestarts: (ptyIds) => {
    if (ptyIds.length === 0) {
      return
    }
    set((s) => ({
      pendingCodexPaneRestartIds: {
        ...s.pendingCodexPaneRestartIds,
        ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
      }
    }))
  },

  consumePendingCodexPaneRestart: (ptyId) => {
    let wasQueued = false
    set((s) => {
      if (!s.pendingCodexPaneRestartIds[ptyId]) {
        return {}
      }
      wasQueued = true
      const next = { ...s.pendingCodexPaneRestartIds }
      delete next[ptyId]
      return { pendingCodexPaneRestartIds: next }
    })
    return wasQueued
  },

  markCodexRestartNotices: (notices) => {
    if (notices.length === 0) {
      return
    }
    set((s) => {
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      for (const notice of notices) {
        const existing = next[notice.ptyId]
        const previousAccountLabel = existing?.previousAccountLabel ?? notice.previousAccountLabel

        // Why: a live Codex pane stays on the account it originally launched
        // with until that pane actually restarts. Repeated account switches
        // must preserve that original pane account; otherwise A -> B -> A
        // keeps showing a stale restart notice even though the pane never left
        // account A and no longer needs a restart.
        if (previousAccountLabel === notice.nextAccountLabel) {
          delete next[notice.ptyId]
          delete nextPendingCodexPaneRestartIds[notice.ptyId]
          continue
        }

        next[notice.ptyId] = {
          previousAccountLabel,
          nextAccountLabel: notice.nextAccountLabel
        }
      }
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  clearCodexRestartNotice: (ptyId) => {
    set((s) => {
      if (!s.codexRestartNoticeByPtyId[ptyId]) {
        return {}
      }
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      delete next[ptyId]
      delete nextPendingCodexPaneRestartIds[ptyId]
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  setTabPaneExpanded: (tabId, expanded) => {
    set((s) => ({
      expandedPaneByTabId: { ...s.expandedPaneByTabId, [tabId]: expanded }
    }))
  },

  setTabCanExpandPane: (tabId, canExpand) => {
    set((s) => ({
      canExpandPaneByTabId: { ...s.canExpandPaneByTabId, [tabId]: canExpand }
    }))
  },

  setTabLayout: (tabId, layout) => {
    set((s) => {
      const next = { ...s.terminalLayoutsByTabId }
      if (layout) {
        next[tabId] = layout
      } else {
        delete next[tabId]
      }
      return { terminalLayoutsByTabId: next }
    })
  },

  queueTabStartupCommand: (tabId, startup) => {
    // Why: launchToken is only meaningful for tracked launch-config reuse;
    // plain startup commands must not mint or carry a synthetic token.
    const launchToken = startup.launchConfig
      ? (startup.launchToken ?? createBrowserUuid())
      : undefined
    set((s) => ({
      pendingStartupByTabId: {
        ...s.pendingStartupByTabId,
        [tabId]: {
          ...startup,
          ...(launchToken ? { launchToken } : {})
        }
      }
    }))
  },

  consumeTabStartupCommand: (tabId) => {
    const pending = get().pendingStartupByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingStartupByTabId }
      delete next[tabId]
      return { pendingStartupByTabId: next }
    })

    return pending
  },

  queueTabSetupSplit: (tabId, startup) => {
    set((s) => ({
      pendingSetupSplitByTabId: {
        ...s.pendingSetupSplitByTabId,
        [tabId]: startup
      }
    }))
  },

  consumeTabSetupSplit: (tabId) => {
    const pending = get().pendingSetupSplitByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingSetupSplitByTabId }
      delete next[tabId]
      return { pendingSetupSplitByTabId: next }
    })

    return pending
  },

  queueTabIssueCommandSplit: (tabId, issueCommand) => {
    set((s) => ({
      pendingIssueCommandSplitByTabId: {
        ...s.pendingIssueCommandSplitByTabId,
        [tabId]: issueCommand
      }
    }))
  },

  consumeTabIssueCommandSplit: (tabId) => {
    const pending = get().pendingIssueCommandSplitByTabId[tabId]
    if (!pending) {
      return null
    }

    set((s) => {
      const next = { ...s.pendingIssueCommandSplitByTabId }
      delete next[tabId]
      return { pendingIssueCommandSplitByTabId: next }
    })

    return pending
  },

  consumePendingSnapshot: (ptyId) => {
    const snapshot = get().pendingSnapshotByPtyId[ptyId]
    if (!snapshot) {
      return null
    }
    set((s) => {
      const next = { ...s.pendingSnapshotByPtyId }
      delete next[ptyId]
      return { pendingSnapshotByPtyId: next }
    })
    return snapshot
  },

  consumePendingColdRestore: (ptyId) => {
    const data = get().pendingColdRestoreByPtyId[ptyId]
    if (!data) {
      return null
    }
    set((s) => {
      const next = { ...s.pendingColdRestoreByPtyId }
      delete next[ptyId]
      return { pendingColdRestoreByPtyId: next }
    })
    return data
  },

  hydrateWorkspaceSession: (session) => {
    set((s) => {
      const validWorktreeIds = new Set(
        Object.values(s.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )
      const knownRepoIds = new Set(s.repos.map((r) => r.id))
      const repoIdsWithLoadedWorktrees = new Set(
        Object.entries(s.worktreesByRepo)
          .filter(([, worktrees]) => worktrees.length > 0)
          .map(([repoId]) => repoId)
      )
      const repoIdsWithAuthoritativeDetectedWorktrees = new Set(
        Object.entries(s.detectedWorktreesByRepo)
          .filter(([, detected]) => detected.authoritative)
          .map(([repoId]) => repoId)
      )
      // Why: the Floating Workspace is intentionally not a repo worktree, but
      // its tabs still use the normal terminal session pipeline so daemon PTYs
      // can survive app restart just like workspace terminals.
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      for (const worktreeId of Object.keys(session.tabsByWorktree)) {
        const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
        if (parsedWorkspaceKey?.type === 'folder') {
          continue
        }
        if (!validWorktreeIds.has(worktreeId)) {
          const repoId = getRepoIdFromWorktreeId(worktreeId)
          // Why (#1158): an empty/missing list can mean degraded hydration; a
          // non-empty repo list is authoritative for deleted-worktree cleanup.
          if (
            knownRepoIds.has(repoId) &&
            !repoIdsWithLoadedWorktrees.has(repoId) &&
            !repoIdsWithAuthoritativeDetectedWorktrees.has(repoId)
          ) {
            validWorktreeIds.add(worktreeId)
          }
        }
      }
      // Why pendingActivationSpawn on hydrated tabs: when a worktree restored
      // from the previous session is mounted for the first time this session
      // (either because it's the restored activeWorktreeId, or because the
      // user clicks it), TerminalPane's connectPanePty fires — either
      // reattaching to the daemon/relay session or spawning fresh. Both call
      // updateTabPtyId, which would otherwise bump lastActivityAt and make
      // the worktree bounce to the top of Recent ~5 seconds later when an
      // unrelated event triggers a re-sort. Tagging at hydration covers the
      // restored-active worktree (which never goes through setActiveWorktree
      // again) and any other restored worktrees the user clicks later. The
      // tag is consumed on the first updateTabPtyId/clearTabPtyId per tab,
      // so subsequent legitimate events (codex restart, new pane) still bump.
      const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
        Object.entries(session.tabsByWorktree)
          .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
          .map(([worktreeId, tabs]) => {
            const quickCommandLabelByTerminalId = new Map(
              (session.unifiedTabs?.[worktreeId] ?? [])
                .filter((tab) => tab.contentType === 'terminal' && tab.quickCommandLabel?.trim())
                .map((tab) => [tab.entityId, tab.quickCommandLabel!.trim()])
            )
            return [
              worktreeId,
              [...tabs]
                .filter((tab) => {
                  // Why: old web-client mirrors could persist host surface ids
                  // with "::"; makePaneKey reserves ":" as its separator.
                  return isValidTerminalTabId(tab.id)
                })
                .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
                .map((tab, index) => {
                  const quickCommandLabel =
                    tab.quickCommandLabel?.trim() || quickCommandLabelByTerminalId.get(tab.id)
                  return {
                    ...clearTransientTerminalState(tab, index),
                    ...(quickCommandLabel ? { quickCommandLabel } : {}),
                    sortOrder: index,
                    pendingActivationSpawn: true
                  }
                })
            ]
          })
          .filter(([, tabs]) => tabs.length > 0)
      )

      const validTabIds = new Set(
        Object.values(tabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )
      const sleepingAgentSessionsByPaneKey = Object.fromEntries(
        Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(([, record]) =>
          validWorktreeIds.has(record.worktreeId)
        )
      )
      const activeWorktreeId =
        session.activeWorktreeId && validWorktreeIds.has(session.activeWorktreeId)
          ? session.activeWorktreeId
          : null
      const activeWorkspaceKey: WorkspaceKey | null =
        session.activeWorkspaceKey && validWorktreeIds.has(session.activeWorkspaceKey)
          ? session.activeWorkspaceKey
          : activeWorktreeId
            ? parseWorkspaceKey(activeWorktreeId)
              ? (activeWorktreeId as WorkspaceKey)
              : worktreeWorkspaceKey(activeWorktreeId)
            : null
      const activeTabId =
        session.activeTabId && validTabIds.has(session.activeTabId) ? session.activeTabId : null
      const activeRepoId =
        session.activeRepoId && s.repos.some((repo) => repo.id === session.activeRepoId)
          ? session.activeRepoId
          : null

      // Why: workspaceSessionReady stays false here. It is set to true in
      // reconnectPersistedTerminals() after all eager PTY spawns complete.
      // This prevents TerminalPane from mounting and spawning duplicate PTYs
      // before the reconnect phase has set ptyId on each tab.
      // Why: fall back to deriving the list from tabsByWorktree ptyIds when
      // activeWorktreeIdsOnShutdown is absent (upgrade from older build).
      // The raw tabs still carry ptyId values before clearTransientTerminalState
      // nulls them, so we can infer which worktrees had active terminals.
      const shutdownIds =
        session.activeWorktreeIdsOnShutdown ??
        Object.entries(session.tabsByWorktree)
          .filter(([, tabs]) => tabs.some((t) => t.ptyId))
          .map(([wId]) => wId)
      const pendingReconnectWorktreeIds = shutdownIds.filter((id) => validWorktreeIds.has(id))

      // Why: capture which specific tabs had live PTYs per worktree from the
      // raw session data BEFORE clearTransientTerminalState nulled the ptyIds.
      // This ensures reconnectPersistedTerminals binds PTYs to the correct
      // tabs, not just tabs[0], which matters for multi-tab worktrees.
      // Also include tabs whose relay session IDs were preserved in
      // remoteSessionIdsByTabId — those tabs were disconnected before shutdown
      // (ptyId was null) but the relay still has their PTY alive.
      const remoteSessionIds = session.remoteSessionIdsByTabId ?? {}
      const pendingReconnectTabByWorktree: Record<string, string[]> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        const liveTabIds = rawTabs
          .filter((t) => (t.ptyId || remoteSessionIds[t.id]) && validTabIds.has(t.id))
          .map((t) => t.id)
        if (liveTabIds.length > 0) {
          pendingReconnectTabByWorktree[worktreeId] = liveTabIds
        }
      }

      // Why: preserve the previous session's ptyId for each tab so that
      // reconnectPersistedTerminals can pass it as sessionId to the daemon's
      // createOrAttach RPC, triggering reattach instead of a fresh spawn.
      const pendingReconnectPtyIdByTabId: Record<string, string> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const worktree = Object.values(s.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === worktreeId)
        const repo = worktree ? s.repos.find((entry) => entry.id === worktree.repoId) : null
        if (repo?.connectionId) {
          continue
        }
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        for (const tab of rawTabs) {
          if (tab.ptyId && validTabIds.has(tab.id)) {
            pendingReconnectPtyIdByTabId[tab.id] = tab.ptyId
          }
        }
      }

      // Why: remote PTY reattach uses the relay's pty.attach RPC, not the
      // local terminal daemon. The loop above correctly skips SSH repos
      // (connectionId check), so there is no overlap.
      for (const [tabId, sessionId] of Object.entries(remoteSessionIds)) {
        if (validTabIds.has(tabId)) {
          pendingReconnectPtyIdByTabId[tabId] = sessionId
        }
      }

      // Why: restore per-worktree active terminal tab from session.
      // If the session has the map, validate that each tab ID still exists.
      // Otherwise, derive it: the active worktree gets activeTabId, others
      // default to their first tab.
      let activeTabIdByWorktree: Record<string, string | null> = {}
      if (session.activeTabIdByWorktree) {
        for (const [wId, tabId] of Object.entries(session.activeTabIdByWorktree)) {
          if (validWorktreeIds.has(wId) && tabId && validTabIds.has(tabId)) {
            activeTabIdByWorktree[wId] = tabId
          }
        }
      } else {
        // Legacy sessions: best-effort derivation
        if (activeWorktreeId && activeTabId) {
          activeTabIdByWorktree[activeWorktreeId] = activeTabId
        }
        for (const [wId, tabs] of Object.entries(tabsByWorktree)) {
          if (!activeTabIdByWorktree[wId] && tabs.length > 0) {
            activeTabIdByWorktree[wId] = tabs[0].id
          }
        }
      }

      // Why: SSH worktrees are not persisted in worktreesByRepo (they're
      // discovered at runtime via the relay). On restart, worktreesByRepo for
      // SSH repos is empty, so the sidebar can't render them. Synthesize
      // placeholder entries from the session's tabsByWorktree so the sidebar
      // shows them immediately. The placeholders will be replaced with full
      // data once SSH reconnects and fetchWorktrees runs.
      // Why: only SSH needs placeholders; local metadata should come from the
      // next successful fetch so the sidebar does not render synthetic entries.
      const sshRepoIds = new Set(s.repos.filter((r) => r.connectionId).map((r) => r.id))
      const worktreesByRepo = { ...s.worktreesByRepo }
      for (const worktreeId of Object.keys(tabsByWorktree)) {
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        if (!sshRepoIds.has(repoId)) {
          continue
        }
        const existing = (worktreesByRepo[repoId] ?? []).find((w) => w.id === worktreeId)
        if (existing) {
          continue
        }
        const path = splitWorktreeId(worktreeId)?.worktreePath ?? ''
        // Why: SSH worktree paths may use backslash separators on Windows remotes.
        const displayName = path.split(/[/\\]/).pop() || path
        const placeholder: Worktree = {
          id: worktreeId,
          repoId,
          displayName,
          comment: '',
          linkedIssue: null,
          linkedPR: null,
          linkedLinearIssue: null,
          linkedGitLabMR: null,
          linkedGitLabIssue: null,
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: 0,
          path,
          head: '',
          branch: '',
          isBare: false,
          isMainWorktree: false
        }
        worktreesByRepo[repoId] = [...(worktreesByRepo[repoId] ?? []), placeholder]
      }

      // Why: the restored-active worktree is set as activeWorktreeId here
      // without ever going through setActiveWorktree, so its first-activation
      // tagging needs to happen at hydration. Record it in
      // everActivatedWorktreeIds so a later re-click doesn't re-tag (which
      // would suppress real activity).
      const nextEverActivated = new Set(s.everActivatedWorktreeIds)
      if (activeWorktreeId) {
        nextEverActivated.add(activeWorktreeId)
      }

      return {
        activeRepoId,
        activeWorktreeId,
        activeWorkspaceKey,
        activeTabId,
        activeTabIdByWorktree,
        tabsByWorktree,
        worktreesByRepo,
        // Why: restore the per-worktree focus-recency map. Pruning of stale
        // entries happens later (App.tsx calls pruneLastVisitedTimestamps
        // after hydration) — not here — because SSH worktrees may still be
        // appearing in worktreesByRepo at this moment.
        lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId ?? {},
        defaultTerminalTabsAppliedByWorktreeId:
          session.defaultTerminalTabsAppliedByWorktreeId ?? {},
        sleepingAgentSessionsByPaneKey,
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        everActivatedWorktreeIds: nextEverActivated,
        // Why: seed worktree nav history with the hydrated active worktree so
        // the first user-driven activation (e.g. a sidebar click to a different
        // worktree) has a prior entry to go Back to. Without this the restored
        // startup worktree is never recorded — recordWorktreeVisit only runs
        // inside activateAndRevealWorktree, which hydration bypasses — so Back
        // stays disabled until a second click produces the first-ever history
        // pair.
        worktreeNavHistory: activeWorktreeId ? [activeWorktreeId] : [],
        worktreeNavHistoryIndex: activeWorktreeId ? 0 : -1,
        ptyIdsByTabId: Object.fromEntries(
          Object.values(tabsByWorktree)
            .flat()
            .map((tab) => [tab.id, []] as const)
        ),
        // Why: with the daemon backend, ptyIds are daemon session IDs that
        // survive app restart. Preserve ptyIdsByLeafId so that
        // reconnectPersistedTerminals can reattach each split-pane leaf
        // to its specific daemon session (not just the tab-level ptyId).
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId)
            .filter(([tabId]) => validTabIds.has(tabId))
            .map(([tabId, layout]) => {
              // Why: old sessions can contain renderer-local pane:1-style leaf
              // ids. Normalize during hydration before runtime/mobile surfaces read them.
              const normalized = normalizeTerminalLayoutSnapshot(layout).snapshot
              const tab = Object.values(tabsByWorktree)
                .flat()
                .find((entry) => entry.id === tabId)
              return [tabId, tab ? sanitizeTerminalLayoutPaneTitles(normalized, tab) : normalized]
            })
        )
      }
    })
  },

  reconnectPersistedTerminals: async (_signal) => {
    const {
      pendingReconnectWorktreeIds,
      pendingReconnectTabByWorktree,
      pendingReconnectPtyIdByTabId,
      terminalLayoutsByTabId,
      tabsByWorktree
    } = get()
    const ids = pendingReconnectWorktreeIds ?? []

    if (ids.length === 0) {
      set({
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {},
        pendingReconnectPtyIdByTabId: {}
      })
      return
    }

    // Why: instead of eagerly spawning PTYs at default 80×24 (which fills
    // eager buffers with content at wrong dimensions that gets garbled on
    // flush), we defer the actual daemon createOrAttach call to connectPanePty
    // where fitAddon provides real dims.
    //
    // This loop just records the daemon session IDs each leaf/tab needs so
    // connectPanePty can pass them as sessionId to pty.spawn at mount time.
    // The layout's ptyIdsByLeafId (preserved from shutdown) already has per-leaf
    // mappings. For single-pane tabs without leaf mappings, store the tab-level
    // ptyId as a sentinel so connectPanePty knows to reattach.
    ensurePtyDispatcher()

    for (const worktreeId of ids) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      const repo = worktree ? get().repos.find((entry) => entry.id === worktree.repoId) : null
      // Why: SSH-backed tabs were previously always skipped because the SSH
      // connection wasn't re-established on startup. Now that we auto-reconnect
      // SSH targets before this loop runs, we allow deferred reattach when the
      // SSH connection is active. Without the active-connection check, we'd try
      // to reattach to a relay that isn't connected yet (the deferred/passphrase
      // targets), which would fail.
      const sshState = repo?.connectionId ? get().sshConnectionStates.get(repo.connectionId) : null
      const sshConnected = repo?.connectionId != null && sshState?.status === 'connected'
      const supportsDeferredReattach = !repo?.connectionId || sshConnected
      console.debug(
        `[reconnect-terminals] worktree=${worktreeId} connectionId=${repo?.connectionId} sshStatus=${sshState?.status} supportsDeferredReattach=${supportsDeferredReattach}`
      )
      const targetTabIds = pendingReconnectTabByWorktree[worktreeId] ?? []
      const tabsToReconnect: TerminalTab[] =
        targetTabIds.length > 0
          ? targetTabIds
              .map((id) => tabs.find((t) => t.id === id))
              .filter((t): t is TerminalTab => t != null)
          : tabs.slice(0, 1)
      if (tabsToReconnect.length === 0) {
        continue
      }

      for (const tab of tabsToReconnect) {
        const tabId = tab.id
        const layout = terminalLayoutsByTabId[tabId]
        const leafPtyMap = layout?.ptyIdsByLeafId ?? {}
        const tabLevelPtyId = pendingReconnectPtyIdByTabId[tabId]
        const hasLeafMappings = Object.keys(leafPtyMap).length > 0

        // Why: populate the wake-hint and the live-pty map so the worktree
        // dot lights up green even before the terminal pane mounts —
        // including deferred SSH worktrees whose connection isn't established
        // yet. tab.ptyId carries the wake-hint sessionId (consumed by
        // pty-connection.ts on remount); ptyIdsByTabId is the source of
        // truth getWorktreeStatus reads for liveness. Without the live-pty
        // population, the sidebar "show active only" filter hides SSH
        // worktrees and the user must manually search for them. The actual
        // PTY reattach is handled later by pty-connection.ts when the
        // terminal pane mounts; this block only sets the visual state.
        console.debug(
          `[reconnect-terminals] tab=${tabId} tabLevelPtyId=${tabLevelPtyId} supportsDeferredReattach=${supportsDeferredReattach} hasLeafMappings=${hasLeafMappings}`
        )
        if (tabLevelPtyId) {
          set((s) => {
            const next = { ...s.tabsByWorktree }
            if (!next[worktreeId]) {
              return {}
            }
            next[worktreeId] = next[worktreeId].map((t) =>
              t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t
            )

            // Why: populate ptyIdsByTabId so the sessions status segment
            // can map daemon session IDs back to tabs (for bound/orphan
            // detection and click-to-navigate). Without this, all sessions
            // appear as orphans until the terminal pane mounts.
            const allPtyIds = hasLeafMappings
              ? (Object.values(leafPtyMap).filter(Boolean) as string[])
              : [tabLevelPtyId]
            return {
              tabsByWorktree: next,
              ptyIdsByTabId: {
                ...s.ptyIdsByTabId,
                [tabId]: allPtyIds
              }
            }
          })
        }
      }
    }

    // Why: deferred SSH targets (passphrase-protected) haven't connected
    // yet, so their tabs' ptyIds were never restored above. Stash the
    // session IDs in a separate map that survives this cleanup so the
    // deferred reconnect code in pty-connection.ts can find them.
    const deferredSshSessionIdsByTabId: Record<string, string> = {}
    for (const worktreeId of ids) {
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      const repo = worktree ? get().repos.find((entry) => entry.id === worktree.repoId) : null
      if (!repo?.connectionId) {
        continue
      }
      const sshConnected = get().sshConnectionStates.get(repo.connectionId)?.status === 'connected'
      if (sshConnected) {
        continue
      }
      const tabs = tabsByWorktree[worktreeId] ?? []
      for (const tab of tabs) {
        const sessionId = pendingReconnectPtyIdByTabId[tab.id]
        if (sessionId) {
          deferredSshSessionIdsByTabId[tab.id] = sessionId
        }
      }
    }

    set({
      workspaceSessionReady: true,
      pendingReconnectWorktreeIds: [],
      pendingReconnectTabByWorktree: {},
      pendingReconnectPtyIdByTabId: {},
      deferredSshSessionIdsByTabId
    })
  }
})
