/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type {
  Repo,
  SetupSplitDirection,
  Tab,
  TerminalLayoutSnapshot,
  TerminalTab,
  TuiAgent,
  Worktree,
  WorkspaceKey,
  WorkspaceSessionState
} from '../../../../shared/types'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session-resume'
import {
  DEFAULT_REPO_BADGE_COLOR,
  FLOATING_TERMINAL_WORKTREE_ID
} from '../../../../shared/constants'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  folderWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { deriveGeneratedTabTitle } from '../../../../shared/agent-tab-title'
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import {
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/stable-pane-id'
import { isValidHostTerminalTabId, isValidTerminalTabId } from '../../../../shared/terminal-tab-id'
import {
  getRepoIdFromWorktreeId,
  splitWorktreeIdForFilesystem
} from '../../../../shared/worktree-id'
import { isWslUncPath } from '../../../../shared/wsl-paths'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import type { StartupCommandDelivery } from '../../../../shared/codex-startup-delivery'
import type { SessionOptionValue } from '../../../../shared/native-chat-session-options'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../shared/local-windows-terminal-runtime'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import type { AgentStartedTelemetry } from '../../lib/worktree-activation'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import { pushClosedTerminalTabSnapshot, pushRecentlyClosedTabKind } from './recently-closed-tabs'
import { isClaudeAgent } from '@/lib/agent-status'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
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
  restorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers
} from '@/components/terminal-pane/pty-transport'
// Why: use the store-free registry (not terminal-parked-tab-watchers, which imports @/store) to avoid re-entering store creation during this slice's eval.
import {
  disposeParkedTerminalWatchersForPtyIds,
  retireParkedTerminalTab
} from '@/components/terminal-pane/terminal-parked-watcher-registry'
import {
  clearCommittedPtyShutdownSettlements,
  hasCommittedPtyShutdownSettlement,
  markCommittedPtyShutdowns,
  noteCommittedPtyShutdownSettlements,
  settleDeferredPtyShutdownExits
} from '@/components/terminal-pane/pty-shutdown-exit-deferral'
import {
  normalizeTerminalLayoutSnapshot,
  resolvePtyBoundActiveLeafId
} from '@/components/terminal-pane/terminal-layout-leaf-ids'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseRemoteRuntimePtyId, toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { requestRemoteWorktreeSleep } from '@/runtime/remote-worktree-sleep'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree,
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  type AgentStatusWorktreeShutdownReason
} from './agent-status'
import {
  buildTerminalTabRetirementPlan,
  isTerminalTabPresent,
  removeSleepingAgentSessionsForTab,
  type TerminalTabCloseReason,
  type TerminalTabRetirementPlan
} from './terminal-tab-retirement'

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

function getPathDisplayName(path: string, fallback: string): string {
  const normalized = path.trim().replace(/[\\/]+$/g, '')
  const basename = normalized.split(/[\\/]/).findLast(Boolean)?.trim()
  return basename || fallback
}

function buildRuntimeSessionPlaceholders({
  repos,
  runtimeHostIdByWorkspaceSessionKey,
  worktreesByRepo
}: {
  repos: readonly Repo[]
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  worktreesByRepo: Record<string, Worktree[]>
}): { repos: Repo[]; worktreesByRepo: Record<string, Worktree[]> } {
  let nextRepos = repos.slice()
  let nextWorktreesByRepo = worktreesByRepo
  for (const workspaceSessionKey of Object.keys(runtimeHostIdByWorkspaceSessionKey)) {
    const hostId = runtimeHostIdByWorkspaceSessionKey[workspaceSessionKey]
    if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
      continue
    }
    const workspaceScope = parseWorkspaceKey(workspaceSessionKey)
    if (workspaceScope?.type === 'folder') {
      continue
    }
    const worktreeId =
      workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : workspaceSessionKey
    // Why: strip the synthetic `::workspace:<uuid>` suffix so path is the real folder — Git callers must not spawn against a nonexistent cwd.
    const parsed = splitWorktreeIdForFilesystem(worktreeId)
    if (!parsed) {
      continue
    }
    const existingRepo = nextRepos.some((repo) => repo.id === parsed.repoId)
    if (!existingRepo) {
      // Why: remote catalogs load after hydration but host-split session writes need owner metadata; skip if the repo id already exists to avoid duplicates.
      nextRepos = [
        ...nextRepos,
        {
          id: parsed.repoId,
          path: parsed.worktreePath,
          displayName: getPathDisplayName(parsed.worktreePath, parsed.repoId),
          badgeColor: DEFAULT_REPO_BADGE_COLOR,
          addedAt: 0,
          connectionId: null,
          executionHostId: hostId
        }
      ]
    }
    const current = nextWorktreesByRepo[parsed.repoId] ?? []
    if (current.some((worktree) => worktree.id === worktreeId)) {
      continue
    }
    const placeholder: Worktree = {
      id: worktreeId,
      repoId: parsed.repoId,
      hostId,
      displayName: getPathDisplayName(parsed.worktreePath, parsed.repoId),
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
      path: parsed.worktreePath,
      head: '',
      branch: '',
      isBare: false,
      isMainWorktree: false
    }
    nextWorktreesByRepo =
      nextWorktreesByRepo === worktreesByRepo ? { ...worktreesByRepo } : nextWorktreesByRepo
    nextWorktreesByRepo[parsed.repoId] = [...current, placeholder]
  }
  return { repos: nextRepos, worktreesByRepo: nextWorktreesByRepo }
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

function isAllowedRemoteWindowsTerminalShell(shell: string | undefined): boolean {
  return (
    shell === 'powershell.exe' ||
    shell === 'pwsh.exe' ||
    shell === 'cmd.exe' ||
    shell === 'wsl.exe' ||
    shell === WINDOWS_GIT_BASH_SHELL
  )
}

function resolveCreatedTabShellOverride(
  explicitShellOverride: string | undefined,
  defaultWindowsShell: string | undefined,
  isRemoteWorktree: boolean,
  remotePlatform: NodeJS.Platform | null,
  isWslWorktree: boolean,
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
): string | undefined {
  if (isRemoteWorktree) {
    if (remotePlatform === 'win32' && isAllowedRemoteWindowsTerminalShell(explicitShellOverride)) {
      return explicitShellOverride
    }
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

function getRemoteConnectionIdForWorktree(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  worktreeId: string
): string | null {
  const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
  if (parsedWorkspaceKey?.type === 'folder') {
    return getFolderWorkspaceConnectionId(state, parsedWorkspaceKey.folderWorkspaceId) ?? null
  }
  const directRepoId = getRepoIdFromWorktreeId(worktreeId)
  const directRepo = state.repos.find((repo) => repo.id === directRepoId)
  if (directRepo) {
    return directRepo.connectionId?.trim() || null
  }

  const worktree = Object.values(state.worktreesByRepo)
    .flat()
    .find((entry) => entry.id === worktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : null
  return repo?.connectionId?.trim() || null
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

function uniquePtyIds(ptyIds: readonly (string | null | undefined)[]): string[] {
  return [...new Set(ptyIds.filter((ptyId): ptyId is string => Boolean(ptyId)))]
}

function resolvePrimaryLayoutPtyId(layout: TerminalLayoutSnapshot): string | null {
  const ptyIdsByLeafId = layout.ptyIdsByLeafId ?? {}
  const activePtyId = layout.activeLeafId ? ptyIdsByLeafId[layout.activeLeafId] : undefined
  return activePtyId ?? Object.values(ptyIdsByLeafId)[0] ?? null
}

function withTerminalTabPtyId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string,
  ptyId: string | null
): Record<string, TerminalTab[]> {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    const index = tabs.findIndex((tab) => tab.id === tabId)
    if (index === -1) {
      continue
    }
    if (tabs[index]?.ptyId === ptyId) {
      return tabsByWorktree
    }
    const nextTabs = [...tabs]
    nextTabs[index] = { ...nextTabs[index]!, ptyId }
    return { ...tabsByWorktree, [worktreeId]: nextTabs }
  }
  return tabsByWorktree
}

export type AutomaticAgentResumeClaim = {
  worktreeId: string
  launchAgent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

export type TerminalSlice = {
  tabsByWorktree: Record<string, TerminalTab[]>
  activeTabId: string | null
  /** Per-worktree last-active tab, restored on worktree switch so the user returns to where they left, not tabs[0]. */
  activeTabIdByWorktree: Record<string, string | null>
  ptyIdsByTabId: Record<string, string[]>
  /** Live pane titles by tabId then paneId; preserves per-pane agent status (unlike the legacy tab title) while TerminalPane is mounted. */
  runtimePaneTitlesByTabId: Record<string, Record<number, string>>
  /** Per-tab unread flags (BEL or agent-complete); ephemeral UI state, not persisted. Cleared when the user activates/interacts with the tab. */
  unreadTerminalTabs: Record<string, true>
  /** Pane-keyed attention marker (narrower than unreadTerminalTabs); clears when the user interacts with the exact pane that raised it. */
  unreadTerminalPanes: Record<string, true>
  /** Agent-completion marker for focus-return auto-ack; separate from unreadTerminalPanes so generic bells still show until interact. */
  unreadAgentCompletionPanes: Record<string, true>
  // Remote guard keys must use renderer-visible, environment-scoped PTY ids; raw runtime handles are only valid at the RPC boundary.
  suppressedPtyExitIds: Record<string, true>
  /** Reference-counted so overlapping shutdowns retain renderer PTY bindings until every owner settles. */
  pendingPtyShutdownIds: Record<string, number>
  pendingCodexPaneRestartIds: Record<string, true>
  codexRestartNoticeByPtyId: Record<
    string,
    { previousAccountLabel: string; nextAccountLabel: string }
  >
  expandedPaneByTabId: Record<string, boolean>
  canExpandPaneByTabId: Record<string, boolean>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  /** Most recent quick-command id per group; in-memory only so a deleted command's stale id can't surface as the split-button label. */
  recentQuickCommandIdByGroup: Record<string, string>
  setRecentQuickCommandForGroup: (groupId: string, quickCommandId: string) => void
  /** Runtime-only claim for auto sleeping-session recovery tabs; bridges the gap between startup payload consumption and hooks going live. */
  automaticAgentResumeClaimsByTabId: Record<string, AutomaticAgentResumeClaim>
  claimAutomaticAgentResume: (tabId: string, claim: AutomaticAgentResumeClaim) => void
  /** Launch-time native-chat prompt echo, keyed by terminal tab. In-memory only. */
  nativeChatLaunchPromptByTabId: Record<string, NativeChatLaunchPrompt>
  seedNativeChatLaunchPrompt: (prompt: NativeChatLaunchPrompt) => void
  markNativeChatLaunchPromptFailed: (tabId: string) => void
  clearNativeChatLaunchPrompt: (tabId: string) => void
  pendingStartupByTabId: Record<
    string,
    {
      command: string
      /** Renderer-delivered startup input for callers needing xterm paste semantics before the submit Enter. */
      delivery?: 'terminal-paste'
      startupCommandDelivery?: StartupCommandDelivery
      env?: Record<string, string>
      envToDelete?: string[]
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      /** Explicit CLI override for host-owned agent launches; omission uses host settings. */
      agentArgsOverride?: string | null
      draftPrompt?: string
      sessionOptions?: Record<string, SessionOptionValue>
      /** Initial prompt-start status for agents that lack native prompt hooks. */
      initialAgentStatus?: { agent: TuiAgent; prompt: string }
      /** Show the restored-session banner when this startup command mounts. */
      showSessionRestoredBanner?: boolean
      /** Telemetry for the `agent_started` event; threaded to the pty:spawn handler so it fires only after spawn confirms, not on click-intent. */
      telemetry?: AgentStartedTelemetry
    }
  >
  pendingInitialCwdByTabId: Record<string, string>
  /** Queued setup-split requests; TerminalPane splits and runs the command in a new pane so the main terminal stays immediately interactive. */
  pendingSetupSplitByTabId: Record<
    string,
    { command: string; env?: Record<string, string>; direction: SetupSplitDirection }
  >
  /** Queued issue-command-split requests, triggered when an issue is linked at worktree creation and the repo's issue automation is enabled. */
  pendingIssueCommandSplitByTabId: Record<string, { command: string; env?: Record<string, string> }>
  tabBarOrderByWorktree: Record<string, string[]>
  workspaceSessionReady: boolean
  restoredRuntimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  markDefaultTerminalTabsApplied: (worktreeId: string) => void
  /** True only after hydrateWorkspaceSession loaded real orca-data.json; guards the session writer so an early-startup crash can't overwrite good data on disk. */
  hydrationSucceeded: boolean
  setHydrationSucceeded: (value: boolean) => void
  pendingReconnectWorktreeIds: string[]
  pendingReconnectTabByWorktree: Record<string, string[]>
  /** tabId → previous session's ptyId; for daemon backends it doubles as the sessionId, so spawn createOrAttach returns the surviving terminal. */
  pendingReconnectPtyIdByTabId: Record<string, string>
  // Why: clearTabPtyId nulls tab.ptyId on disconnect; keep the last relay ID here so session save can still capture it for reattach after restart.
  lastKnownRelayPtyIdByTabId: Record<string, string>
  /** ANSI snapshots from daemon reattach, keyed by new ptyId; TerminalPane writes them to xterm.js to restore visual state. */
  pendingSnapshotByPtyId: Record<
    string,
    { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean }
  >
  consumePendingSnapshot: (
    ptyId: string
  ) => { snapshot: string; cols?: number; rows?: number; isAlternateScreen?: boolean } | null
  /** Cold-restore data (read-only scrollback shown above the fresh prompt) from disk history after a daemon crash, keyed by the new ptyId. */
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
      /** Pre-allocated tab id (main mints it for CLI/runtime PTYs with a baked pane key); minted fresh on omit or cross-worktree collision. */
      id?: string
      /** Coding-harness agent launched here, recorded so the tab bar shows the provider icon before the agent's first hook event. */
      launchAgent?: TuiAgent
      quickCommandLabel?: string | null
      /** Initial native-chat view mode; agent launches pass 'chat' when openAgentTabsInChatByDefault is on, else omitted for the 'terminal' default. */
      viewMode?: Tab['viewMode']
      startupCwd?: string
    }
  ) => TerminalTab
  openNewTerminalTabInActiveWorkspace: (groupId: string) => Promise<void>
  closeTab: (
    tabId: string,
    opts?: {
      recordInteraction?: boolean
      reason?: TerminalTabCloseReason
      captureRecentlyClosed?: boolean
      remoteCloseOwnedByHost?: boolean
      localPtyTeardownOwnedExternally?: boolean
      precomputedRetirementPlan?: TerminalTabRetirementPlan
    }
  ) => void
  reorderTabs: (worktreeId: string, tabIds: string[]) => void
  setTabBarOrder: (worktreeId: string, order: string[]) => void
  setActiveTab: (tabId: string) => void
  setActiveTabForWorktree: (worktreeId: string, tabId: string) => void
  updateTabTitle: (tabId: string, title: string) => void
  setGeneratedTabTitleFromAgentPrompt: (
    paneKey: string,
    prompt: string,
    options?: { replaceExistingGeneratedTitle?: boolean }
  ) => void
  clearTabLaunchAgent: (tabId: string) => void
  setRuntimePaneTitle: (tabId: string, paneId: number, title: string) => void
  clearRuntimePaneTitle: (tabId: string, paneId: number) => void
  /** Mark a tab unread (agent working→idle); skipped when the tab is visible, since a "seen" flag would never clear. */
  markTerminalTabUnread: (tabId: string) => void
  markTerminalPaneUnread: (paneKey: string) => void
  markAgentCompletionPaneUnread: (paneKey: string) => void
  /** Clear a tab's unread indicator on user interaction (ghostty "show until interact" model). */
  clearTerminalTabUnread: (tabId: string) => void
  clearTerminalPaneUnread: (paneKey: string) => void
  setTabCustomTitle: (
    tabId: string,
    title: string | null,
    opts?: { recordInteraction?: boolean }
  ) => void
  setTabColor: (tabId: string, color: string | null) => void
  updateTabPtyId: (tabId: string, ptyId: string, replacedPtyId?: string) => void
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
  isPtyShutdownPending: (ptyId: string) => boolean
  queueCodexPaneRestarts: (ptyIds: string[]) => void
  consumePendingCodexPaneRestart: (ptyId: string) => boolean
  markCodexRestartNotices: (
    notices: { ptyId: string; previousAccountLabel: string; nextAccountLabel: string }[]
  ) => void
  clearCodexRestartNotice: (ptyId: string) => void
  setTabPaneExpanded: (tabId: string, expanded: boolean) => void
  setTabCanExpandPane: (tabId: string, canExpand: boolean) => void
  setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot | null) => void
  syncPaneDetachPtyOwnership: (args: {
    detachedLeafId: string
    detachedPtyId: string | null
    sourceLayout: TerminalLayoutSnapshot
    sourceTabId: string
    targetTabId: string
  }) => void
  queueTabStartupCommand: (
    tabId: string,
    startup: {
      command: string
      delivery?: 'terminal-paste'
      startupCommandDelivery?: StartupCommandDelivery
      env?: Record<string, string>
      envToDelete?: string[]
      launchConfig?: SleepingAgentLaunchConfig
      resumeProviderSession?: AgentProviderSessionMetadata
      launchToken?: string
      launchAgent?: TuiAgent
      agentArgsOverride?: string | null
      draftPrompt?: string
      sessionOptions?: Record<string, SessionOptionValue>
      initialAgentStatus?: { agent: TuiAgent; prompt: string }
      showSessionRestoredBanner?: boolean
      telemetry?: AgentStartedTelemetry
    }
  ) => void
  queueTabInitialCwd: (tabId: string, cwd: string) => void
  consumeTabInitialCwd: (tabId: string) => string | null
  consumeTabStartupCommand: (tabId: string) => {
    command: string
    delivery?: 'terminal-paste'
    startupCommandDelivery?: StartupCommandDelivery
    env?: Record<string, string>
    envToDelete?: string[]
    launchConfig?: SleepingAgentLaunchConfig
    resumeProviderSession?: AgentProviderSessionMetadata
    launchToken?: string
    launchAgent?: TuiAgent
    agentArgsOverride?: string | null
    draftPrompt?: string
    sessionOptions?: Record<string, SessionOptionValue>
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
  /** `${tabId}:${leafId}` → ms when the prompt-cache countdown started (agent idle); null means no active timer for that pane. */
  cacheTimerByKey: Record<string, number | null>
  setCacheTimerStartedAt: (key: string, ts: number | null) => void
  /** paneKey → wall-clock user input time; hibernation uses it to avoid sleeping a completed agent pane the user turned into a shell. */
  lastTerminalInputAtByPaneKey: Record<string, number>
  recordTerminalInput: (paneKey: string, timestamp?: number) => void
  /** Seed cache timers for idle Claude sessions missing one; called when the feature is enabled mid-session. */
  seedCacheTimersForIdleTabs: () => void
  /** SSH target IDs needing a passphrase; reconnect is deferred until the user focuses an affected terminal tab. */
  deferredSshReconnectTargets: string[]
  /** tabId → remote PTY session ID for deferred (passphrase) SSH tabs; survives the startup clear because reconnect runs later, on focus. */
  deferredSshSessionIdsByTabId: Record<string, string>
  setDeferredSshReconnectTargets: (targetIds: string[]) => void
  removeDeferredSshReconnectTarget: (targetId: string) => void
  removeDeferredSshSessionId: (tabId: string) => void
  hydrateWorkspaceSession: (
    session: WorkspaceSessionState,
    options?: HydrateWorkspaceSessionOptions
  ) => void
  reconnectPersistedTerminals: (signal?: AbortSignal) => Promise<void>
}

export type HydrateWorkspaceSessionOptions = {
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
} & WorkspaceSessionHydrationOptions

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
  pendingPtyShutdownIds: {},
  pendingCodexPaneRestartIds: {},
  codexRestartNoticeByPtyId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  pendingStartupByTabId: {},
  pendingInitialCwdByTabId: {},
  pendingSetupSplitByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  automaticAgentResumeClaimsByTabId: {},
  nativeChatLaunchPromptByTabId: {},
  tabBarOrderByWorktree: {},
  workspaceSessionReady: false,
  restoredRuntimeHostIdByWorkspaceSessionKey: {},
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

  claimAutomaticAgentResume: (tabId, claim) => {
    set((s) => ({
      automaticAgentResumeClaimsByTabId: {
        ...s.automaticAgentResumeClaimsByTabId,
        [tabId]: claim
      }
    }))
  },

  seedNativeChatLaunchPrompt: (prompt) => {
    set((s) => ({
      nativeChatLaunchPromptByTabId: {
        ...s.nativeChatLaunchPromptByTabId,
        [prompt.tabId]: prompt
      }
    }))
  },

  markNativeChatLaunchPromptFailed: (tabId) => {
    set((s) => {
      const current = s.nativeChatLaunchPromptByTabId[tabId]
      if (!current || current.failed) {
        return {}
      }
      return {
        nativeChatLaunchPromptByTabId: {
          ...s.nativeChatLaunchPromptByTabId,
          [tabId]: { ...current, failed: true }
        }
      }
    })
  },

  clearNativeChatLaunchPrompt: (tabId) => {
    set((s) => {
      if (!s.nativeChatLaunchPromptByTabId[tabId]) {
        return {}
      }
      const next = { ...s.nativeChatLaunchPromptByTabId }
      delete next[tabId]
      return { nativeChatLaunchPromptByTabId: next }
    })
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
      // Why: a real pane write clears any ':seed' sentinel from seedCacheTimersForIdleTabs, avoiding phantom timers when the seed key doesn't match the real pane.
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
    // Why: tabs already idle when the feature is enabled mid-session missed their working→idle transition, so seed timers for them.
    const s = get()
    const now = Date.now()
    const updates: Record<string, number> = {}
    for (const tabs of Object.values(s.tabsByWorktree)) {
      for (const tab of tabs) {
        if (!tab.title || !isClaudeAgent(tab.title)) {
          continue
        }
        const status = classifyTitleActivity(tab.title)
        if (status === null || status === 'working') {
          continue
        }
        // Why: the store doesn't know which pane holds the idle session, so use a ':seed' sentinel; setCacheTimerStartedAt clears it on any real pane write.
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
      // Why: honor a caller-supplied tab id but mint on collision — aliasing two PTYs to one id corrupts agent-status routing. See docs/cli-terminal-hook-pane-key.md.
      // Why: only honor a non-empty trimmed hint; useIpcEvents spreads `id` whenever tabId !== undefined, so a stray '' would break paneKey routing.
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
      const startupCwd = options?.startupCwd
      const remoteConnectionId = getRemoteConnectionIdForWorktree(s, worktreeId)
      const isRemoteWorktree = Boolean(remoteConnectionId)
      const isWslWorktree = worktreeUsesWslPath(s, worktreeId)
      const createdShellOverride = resolveCreatedTabShellOverride(
        shellOverride,
        s.settings?.terminalWindowsShell,
        // Why: SSH PTYs ignore local Windows shell selection; a local shell icon would mislabel a remote terminal.
        isRemoteWorktree,
        remoteConnectionId
          ? ((s.sshConnectionStates.get(remoteConnectionId)
              ?.remotePlatform as NodeJS.Platform | null) ?? null)
          : null,
        // Why: new terminals enter the worktree's repo-scoped WSL distro even when the global Windows shell is PowerShell/cmd.exe.
        isWslWorktree,
        isRemoteWorktree ? undefined : getLocalProjectExecutionRuntimeContext(s, worktreeId)
      )
      tab = {
        id,
        // Why: CLI-created background sessions already own a PTY, so reveal attaches instead of spawning a duplicate.
        ptyId: options?.initialPtyId ?? null,
        worktreeId,
        // Why: reuse the lowest free ordinal so a fresh terminal stays "Terminal 1" after older tabs close, not a monotonic counter.
        title: defaultTitle,
        defaultTitle,
        ...(quickCommandLabel ? { quickCommandLabel } : {}),
        customTitle: null,
        color: null,
        sortOrder: existing.length,
        createdAt: Date.now(),
        ...(createdShellOverride !== undefined ? { shellOverride: createdShellOverride } : {}),
        ...(startupCwd && startupCwd.length > 0 ? { startupCwd } : {}),
        ...(options?.launchAgent ? { launchAgent: options.launchAgent } : {}),
        // Why: mark click-caused (not work-caused) spawns so updateTabPtyId skips the activity/sortEpoch bump that would reorder Recent/Smart on click.
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
              // Why: repair every group before adding the new tab, or inactive/background creation can revive stale focus.
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
        createdAt: tab.createdAt,
        // Why: omit for non-agent tabs so they keep the implicit 'terminal' view mode.
        ...(options?.viewMode ? { viewMode: options.viewMode } : {})
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
        // Why: publish the unified tab atomically with the runtime tab so a transient legacy mount can't race the split host.
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
    const workspaceScope = parseWorkspaceKey(worktreeId)
    const worktreeRoute =
      worktreeId === FLOATING_TERMINAL_WORKTREE_ID || workspaceScope?.type === 'folder'
        ? null
        : resolveWorktreeOperationRouteResult(state, worktreeId)
    if (worktreeRoute && worktreeRoute.kind !== 'resolved') {
      return
    }
    const runtimeEnvironmentId = worktreeRoute
      ? worktreeRoute.route.runtimeEnvironmentId
      : getRuntimeEnvironmentIdForWorktree(state, worktreeId)
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
    // Why: Cmd+J shares the titlebar-button creation path, so append the new terminal after mixed editor/browser tabs, not first.
    get().setTabBarOrder(worktreeId, [...base.filter((id) => id !== terminal.id), terminal.id])
    focusTerminalTabSurface(terminal.id)
  },

  closeTab: (tabId, opts) => {
    const closeReason = opts?.reason ?? 'user'
    const retiresSession = closeReason === 'user' || closeReason === 'cleanup'
    const retirementPlan =
      opts?.precomputedRetirementPlan?.tabId === tabId
        ? opts.precomputedRetirementPlan
        : buildTerminalTabRetirementPlan(get(), tabId)
    let closingWorktreeId: string | null = null

    // Why: a parked tab has no mounted TerminalPane cleanup, so revoke its observer/candidate state before provider exit races.
    retireParkedTerminalTab(tabId)
    if (retiresSession) {
      const fallbackWorktreeRoute = retirementPlan.worktreeId
        ? resolveTerminalWorktreeRoute(get(), retirementPlan.worktreeId)
        : { runtimeEnvironmentId: null }
      const retirementTasks: Promise<unknown>[] = opts?.localPtyTeardownOwnedExternally
        ? []
        : retirementPlan.localOrSshPtyIds.map(async (ptyId) => window.api.pty.kill(ptyId))
      const localOrSshTaskCount = retirementTasks.length
      if (!opts?.remoteCloseOwnedByHost) {
        for (const terminal of retirementPlan.runtimeTerminals) {
          if (!terminal.environmentId && !fallbackWorktreeRoute) {
            continue
          }
          const environmentId =
            terminal.environmentId ?? fallbackWorktreeRoute?.runtimeEnvironmentId
          retirementTasks.push(
            callRuntimeRpc(
              environmentId ? { kind: 'environment', environmentId } : { kind: 'local' },
              'terminal.close',
              { terminal: terminal.handle }
            )
          )
        }
      }
      if (retirementPlan.unroutablePtyIds.length > 0) {
        console.warn('[terminal-retirement] skipped unroutable runtime handles', {
          tabId,
          count: retirementPlan.unroutablePtyIds.length
        })
      }
      // Why: keep close synchronous and idempotent — provider failures must not reject into the UI or block ownership revocation.
      void Promise.allSettled(retirementTasks).then((results) => {
        const localOrSshFailures = results
          .slice(0, localOrSshTaskCount)
          .filter((result) => result.status === 'rejected').length
        const runtimeFailures = results
          .slice(localOrSshTaskCount)
          .filter((result) => result.status === 'rejected').length
        if (localOrSshFailures > 0 || runtimeFailures > 0) {
          console.warn('[terminal-retirement] provider teardown failed', {
            tabId,
            localOrSshFailures,
            runtimeFailures
          })
        }
      })
    }

    set((s) => {
      const next = { ...s.tabsByWorktree }
      let closedTab: TerminalTab | null = null
      let closedWorktreeId: string | null = null
      for (const wId of Object.keys(next)) {
        const before = next[wId]
        const closing = before.find((t) => t.id === tabId)
        if (closing) {
          closingWorktreeId = wId
          // Why: capture the first-matched tab's snapshot for the Cmd+Shift+T reopen stack (see capturedSnapshot below).
          if (!closedTab) {
            closedTab = closing
            closedWorktreeId = wId
          }
        }
        const after = before.filter((t) => t.id !== tabId)
        if (after.length !== before.length) {
          next[wId] = after
        }
      }
      // Why: only explicit user closes feed the Cmd+Shift+T reopen stack; cleanup/PTY-exit closes must not pollute undo history.
      const capturedSnapshot =
        closeReason === 'user' &&
        opts?.captureRecentlyClosed !== false &&
        closedTab &&
        closedWorktreeId
          ? {
              ...(closedTab.startupCwd ? { startupCwd: closedTab.startupCwd } : {}),
              ...(closedTab.shellOverride ? { shellOverride: closedTab.shellOverride } : {}),
              ...(closedTab.customTitle ? { customTitle: closedTab.customTitle } : {}),
              ...(closedTab.color ? { color: closedTab.color } : {})
            }
          : null
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
      const nextDeferredSshSessionIdsByTabId = { ...s.deferredSshSessionIdsByTabId }
      delete nextDeferredSshSessionIdsByTabId[tabId]
      const nextPendingReconnectPtyIdByTabId = { ...s.pendingReconnectPtyIdByTabId }
      delete nextPendingReconnectPtyIdByTabId[tabId]
      const nextRuntimePaneTitlesByTabId = { ...s.runtimePaneTitlesByTabId }
      delete nextRuntimePaneTitlesByTabId[tabId]
      // Why: keep the same reference when the closing tab had no unread flag, so unrelated closes don't force full-state selector re-eval.
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
      const nextSleepingAgentSessionsByPaneKey = retiresSession
        ? removeSleepingAgentSessionsForTab(s.sleepingAgentSessionsByPaneKey, tabId)
        : s.sleepingAgentSessionsByPaneKey
      const nextPendingStartupByTabId = { ...s.pendingStartupByTabId }
      delete nextPendingStartupByTabId[tabId]
      const nextAutomaticAgentResumeClaimsByTabId = { ...s.automaticAgentResumeClaimsByTabId }
      delete nextAutomaticAgentResumeClaimsByTabId[tabId]
      const nextNativeChatLaunchPromptByTabId = { ...s.nativeChatLaunchPromptByTabId }
      delete nextNativeChatLaunchPromptByTabId[tabId]
      const nextPendingInitialCwdByTabId = { ...s.pendingInitialCwdByTabId }
      delete nextPendingInitialCwdByTabId[tabId]
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      delete nextPendingSetupSplitByTabId[tabId]
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      delete nextPendingIssueCommandSplitByTabId[tabId]
      const nextCacheTimer = { ...s.cacheTimerByKey }
      // Why: cache timer keys are `${tabId}:${leafId}` composites; remove all entries for the closing tab.
      for (const key of Object.keys(nextCacheTimer)) {
        if (key.startsWith(`${tabId}:`)) {
          delete nextCacheTimer[key]
        }
      }
      // Why: keep activeTabIdByWorktree in sync when closing a background-worktree tab, else the stale remembered tab falls back to tabs[0] on switch.
      const nextActiveTabIdByWorktree = { ...s.activeTabIdByWorktree }
      for (const [wId, tabs] of Object.entries(next)) {
        if (nextActiveTabIdByWorktree[wId] === tabId) {
          nextActiveTabIdByWorktree[wId] = tabs[0]?.id ?? null
        }
      }

      // Why: keep tabBarOrderByWorktree in sync so stale terminal IDs don't linger and shift positions on later tab operations.
      const nextTabBarOrderByWorktree: Record<string, string[]> = {
        ...s.tabBarOrderByWorktree
      }
      for (const wId of Object.keys(nextTabBarOrderByWorktree)) {
        const order = nextTabBarOrderByWorktree[wId]
        if (order?.includes(tabId)) {
          nextTabBarOrderByWorktree[wId] = order.filter((entryId) => entryId !== tabId)
        }
      }

      // Why: clean up unconsumed snapshot/cold-restore data (e.g. tab closed before TerminalPane mounted) to prevent unbounded store growth across restarts.
      let nextSnapshots = s.pendingSnapshotByPtyId
      let nextColdRestores = s.pendingColdRestoreByPtyId
      const closingPtyIds = new Set([
        ...retirementPlan.localOrSshPtyIds,
        ...retirementPlan.runtimeTerminals.map((terminal) => terminal.ptyId),
        ...retirementPlan.cleanupOnlyPtyIds,
        ...retirementPlan.unroutablePtyIds
      ])
      for (const closingId of closingPtyIds) {
        if (closingId in nextSnapshots) {
          nextSnapshots = { ...nextSnapshots }
          delete nextSnapshots[closingId]
        }
        if (closingId in nextColdRestores) {
          nextColdRestores = { ...nextColdRestores }
          delete nextColdRestores[closingId]
        }
      }

      return {
        tabsByWorktree: next,
        activeTabId: s.activeTabId === tabId ? null : s.activeTabId,
        activeTabIdByWorktree: nextActiveTabIdByWorktree,
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        deferredSshSessionIdsByTabId: nextDeferredSshSessionIdsByTabId,
        pendingReconnectPtyIdByTabId: nextPendingReconnectPtyIdByTabId,
        runtimePaneTitlesByTabId: nextRuntimePaneTitlesByTabId,
        ...(nextSleepingAgentSessionsByPaneKey !== s.sleepingAgentSessionsByPaneKey
          ? { sleepingAgentSessionsByPaneKey: nextSleepingAgentSessionsByPaneKey }
          : {}),
        // Why: skip writing unreadTerminalTabs when unchanged to avoid a no-op state allocation that re-evaluates full-state selectors. Mirrors tabs.ts.
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
        automaticAgentResumeClaimsByTabId: nextAutomaticAgentResumeClaimsByTabId,
        nativeChatLaunchPromptByTabId: nextNativeChatLaunchPromptByTabId,
        pendingInitialCwdByTabId: nextPendingInitialCwdByTabId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        cacheTimerByKey: nextCacheTimer,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        pendingSnapshotByPtyId: nextSnapshots,
        pendingColdRestoreByPtyId: nextColdRestores,
        ...(capturedSnapshot && closedWorktreeId
          ? {
              recentlyClosedTerminalTabsByWorktree: pushClosedTerminalTabSnapshot(
                s.recentlyClosedTerminalTabsByWorktree,
                closedWorktreeId,
                capturedSnapshot
              ),
              recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
                s.recentlyClosedTabKindsByWorktree,
                closedWorktreeId,
                'terminal'
              )
            }
          : {})
      }
    })
    // Why: closing a tab sweeps live and retained agent-status for it; use dropAgentStatusByTabPrefix so retention suppressors block a same-frame live→gone re-snapshot.
    // Why: Pi can leave a completed row keyed under an already-missing tab id; pass the worktree to sweep that orphan while preserving active pre-render child rows.
    get().dropAgentStatusByTabPrefix(
      tabId,
      closingWorktreeId ? { worktreeId: closingWorktreeId } : undefined
    )
    // Why: retired pane keys never recur, so stranded foreground entries would accumulate for the renderer's whole lifetime.
    get().clearPaneForegroundAgentByTabPrefix(tabId)
    // Why: closing a tab permanently retires its panes (reopen mints a fresh leafId), so drop hibernation output epochs to keep the module map from growing forever.
    forgetAgentHibernationTabOutput(tabId)
    // Why: same rationale — retired tab ids never recur, so drop the foreground last-seen and consumed agent-startup delivery guards.
    forgetForegroundTerminalTabs([tabId])
    forgetAgentStartupDeliveriesForTabs([tabId])
    for (const tabs of Object.values(get().unifiedTabsByWorktree)) {
      const workspaceItem = tabs.find(
        (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
      )
      if (workspaceItem) {
        get().closeUnifiedTab(workspaceItem.id, {
          recordInteraction: opts?.recordInteraction,
          terminalRetirementHandled: true
        })
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
      // Why: focusing a terminal tab clears its bell, but only for the active worktree — clearing a not-yet-visible background tab (worktree activation / jump-to-agent) would swallow the signal.
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
      // Why: only pin global activeTabId to active-worktree tabs — markTerminalTabUnread treats it as "the visible tab" and would swallow BELs on a background tab (e.g. jump-to-agent).
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
      // Why: mutate only the owning worktree's tab array — rebuilding all of them would break shallow-equality selectors and spuriously re-render background worktrees on every OSC title frame.
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
              // Why: PTYs can briefly emit an empty title as an agent exits; keep the stable fallback instead of a blank tab.
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
      // Why: title changes affect agent-status sort scoring, so re-sort — but only background worktrees; active-worktree changes are click-driven PTY-remount side-effects (bug PR #209).
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

  setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt, options) => {
    // Why: setAgentStatus is high-frequency; skip derive/set unless the feature is on and this tab still needs a (re)generated title.
    if (get().settings?.tabAutoGenerateTitle !== true) {
      return
    }
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || prompt.length === 0) {
      return
    }
    const ownerWorktreeId = getTerminalTabOwnerWorktreeId(get().tabsByWorktree, tabId)
    if (!ownerWorktreeId) {
      return
    }
    const tabs = get().tabsByWorktree[ownerWorktreeId] ?? []
    const currentTab = tabs.find((tab) => tab.id === tabId)
    if (!currentTab || currentTab.customTitle?.trim() || currentTab.quickCommandLabel?.trim()) {
      return
    }
    const existingGeneratedTitle = currentTab.generatedTitle?.trim()
    if (existingGeneratedTitle && options?.replaceExistingGeneratedTitle !== true) {
      return
    }
    const generatedTitle = deriveGeneratedTabTitle(prompt)
    if (!generatedTitle || existingGeneratedTitle === generatedTitle) {
      return
    }
    set((s) => {
      const ownerTabsForWrite = s.tabsByWorktree[ownerWorktreeId]
      if (!ownerTabsForWrite) {
        return s
      }
      const tabIndex = ownerTabsForWrite.findIndex((tab) => tab.id === tabId)
      const tabForWrite = ownerTabsForWrite[tabIndex]
      // Why: re-check inside set so concurrent renames / setting flips win.
      if (
        !tabForWrite ||
        s.settings?.tabAutoGenerateTitle !== true ||
        tabForWrite.customTitle?.trim() ||
        tabForWrite.quickCommandLabel?.trim()
      ) {
        return s
      }
      const latestGeneratedTitle = tabForWrite.generatedTitle?.trim()
      if (
        latestGeneratedTitle &&
        (latestGeneratedTitle === generatedTitle || options?.replaceExistingGeneratedTitle !== true)
      ) {
        return s
      }
      const ownerTabs = ownerTabsForWrite.map((tab) =>
        tab.id === tabId ? { ...tab, generatedTitle } : tab
      )
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
      // Why: smart sort's title-heuristic fallback (Edge case 9) reads this map; a hookless 'working' → 'permission' title change must re-sort, but only on classification change.
      const classificationChanged =
        classifyTitleActivity(prevTitle ?? '') !== classifyTitleActivity(title)
      // Why: suppress the sortEpoch bump when the pane lives in the active worktree — its title change is a click side-effect (PTY remount), the bug PR #209 fixed; skip if orphaned.
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

      // Why: clearing a classified title changes the smart-sort title-heuristic verdict, so it needs a re-sort. See setRuntimePaneTitle.
      const hadClassification = classifyTitleActivity(prevTitle ?? '') !== null
      // Why: same active-worktree gate as setRuntimePaneTitle — click-driven teardown clears must not re-rank the sidebar; skip when owner is missing (orphaned).
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
    // Why: terminal attention persists until real interaction ("show until interact"); keystroke/pointerdown clears via clearTerminalTabUnread, tab/group activation clears directly.
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
      // Why: tab color is host-authoritative for remote-server tabs; mirror it so it persists instead of reverting on the next snapshot.
      const state = get()
      const owningWorktreeId = Object.keys(state.unifiedTabsByWorktree).find((wId) =>
        (state.unifiedTabsByWorktree[wId] ?? []).some((entry) => entry.id === item.id)
      )
      if (
        owningWorktreeId &&
        resolveTerminalWorktreeRoute(state, owningWorktreeId)?.runtimeEnvironmentId
      ) {
        void import('@/runtime/web-runtime-session').then(({ setWebRuntimeTabProps }) =>
          setWebRuntimeTabProps({ worktreeId: owningWorktreeId, tabId: item.id, color })
        )
      }
    }
  },

  updateTabPtyId: (tabId, ptyId, replacedPtyId) => {
    // Why: final guard preventing a late caller from recreating retired tab maps (async spawn owners still do their own provider teardown).
    if (!isTerminalTabPresent(get(), tabId)) {
      return
    }
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    const isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      const remote = parseRemoteRuntimePtyId(ptyId)
      const legacyRemotePtyId = remote?.environmentId ? toRemoteRuntimePtyId(remote.handle) : null
      const hasLegacyPtyBinding = legacyRemotePtyId
        ? existingPtyIds.includes(legacyRemotePtyId)
        : false
      const explicitReplacementPtyId = replacedPtyId !== ptyId ? replacedPtyId : undefined
      const replacementPtyId =
        explicitReplacementPtyId ?? (hasLegacyPtyBinding ? legacyRemotePtyId : null)
      const boundReplacementPtyId =
        replacementPtyId && existingPtyIds.includes(replacementPtyId) ? replacementPtyId : null
      const nextPtyIds = boundReplacementPtyId
        ? [...new Set(existingPtyIds.map((id) => (id === boundReplacementPtyId ? ptyId : id)))]
        : existingPtyIds.includes(ptyId)
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
        // Why: consume one pendingActivationSpawn unit — a split remounts several panes per click, each activation callback suppressed without hiding later real activity.
        const { pendingActivationSpawn: _unused, ...rest } = tab
        void _unused
        // Why: tab.ptyId is the single-pane fallback for legacy attach; later split-pane spawns must not steal it or remount/close reattaches the tab to the wrong PTY.
        const currentTabPtyId = tab.ptyId === replacementPtyId ? ptyId : tab.ptyId
        const nextTabPtyId = currentTabPtyId ?? nextPtyIds[0] ?? null
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
      // Why: a new active-worktree tab's first PTY flips the live-tab signal (+12), so bump sortEpoch — but suppress on activation spawns (click side-effect, not activity).
      const isFirstPty = existingPtyIds.length === 0
      const isActiveWorktree = worktreeId != null && s.activeWorktreeId === worktreeId
      const shouldBumpSortEpoch = isFirstPty && isActiveWorktree && !wasActivationSpawn
      const shouldRetainSuppressedExit = Boolean(
        explicitReplacementPtyId &&
        (s.suppressedPtyExitIds[ptyId] ||
          (replacementPtyId && s.suppressedPtyExitIds[replacementPtyId]))
      )
      const nextSuppressedPtyExitIds = { ...s.suppressedPtyExitIds }
      delete nextSuppressedPtyExitIds[ptyId]
      if (replacementPtyId) {
        delete nextSuppressedPtyExitIds[replacementPtyId]
      }
      if (shouldRetainSuppressedExit) {
        // Why: handle rotation keeps the same terminal lifecycle; an intentional exit racing the rotation must stay suppressed once.
        nextSuppressedPtyExitIds[ptyId] = true
      }
      const hasReplacementPendingRestart = replacementPtyId
        ? replacementPtyId in s.pendingCodexPaneRestartIds
        : false
      const hasReplacementRestartNotice = replacementPtyId
        ? replacementPtyId in s.codexRestartNoticeByPtyId
        : false
      const hasReplacementMigrationUnsupported = replacementPtyId
        ? replacementPtyId in s.migrationUnsupportedByPtyId
        : false
      const nextPendingCodexPaneRestartIds = hasReplacementPendingRestart
        ? { ...s.pendingCodexPaneRestartIds }
        : s.pendingCodexPaneRestartIds
      const nextCodexRestartNoticeByPtyId = hasReplacementRestartNotice
        ? { ...s.codexRestartNoticeByPtyId }
        : s.codexRestartNoticeByPtyId
      const nextMigrationUnsupportedByPtyId = hasReplacementMigrationUnsupported
        ? { ...s.migrationUnsupportedByPtyId }
        : s.migrationUnsupportedByPtyId
      if (replacementPtyId) {
        if (hasReplacementPendingRestart) {
          nextPendingCodexPaneRestartIds[ptyId] = true
          delete nextPendingCodexPaneRestartIds[replacementPtyId]
        }
        if (hasReplacementRestartNotice) {
          const replacedNotice = nextCodexRestartNoticeByPtyId[replacementPtyId]
          nextCodexRestartNoticeByPtyId[ptyId] ??= replacedNotice
          delete nextCodexRestartNoticeByPtyId[replacementPtyId]
        }
        if (hasReplacementMigrationUnsupported) {
          const replacedMigrationUnsupported = nextMigrationUnsupportedByPtyId[replacementPtyId]
          nextMigrationUnsupportedByPtyId[ptyId] ??= {
            ...replacedMigrationUnsupported,
            ptyId
          }
          delete nextMigrationUnsupportedByPtyId[replacementPtyId]
        }
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
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        migrationUnsupportedByPtyId: nextMigrationUnsupportedByPtyId,
        ...(shouldBumpSortEpoch ? { sortEpoch: s.sortEpoch + 1 } : {})
      }
    })

    // Why: activation spawns come from clicking a worktree, not work in it — skip the lastActivityAt stamp and sortEpoch bump; other spawn reasons still bump.
    if (worktreeId && !wasActivationSpawn && !isRemoteRuntimeMirror) {
      get().bumpWorktreeActivity(worktreeId)
    }
  },

  clearTabPtyId: (tabId, ptyId) => {
    if (ptyId && get().pendingPtyShutdownIds[ptyId]) {
      // Why: an owner exit can arrive before its post-stop inventory; keep the renderer binding retryable until verification commits.
      return
    }
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
        // Why: consume pendingActivationSpawn on real activation clears, but keep it when clearing a stale wake-hint id — its fallback spawn still needs the suppression.
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
      if (worktreeId) {
        nextPtyIdsByTabId[tabId] = remainingPtyIds
      } else {
        // Why: repo purge can retire the owning tab before its async exit arrives; don't resurrect an orphan PTY index.
        delete nextPtyIdsByTabId[tabId]
      }
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
      // Why: a passed ptyId means the PTY actually exited — drop its lastKnown so restart won't reattach a dead relay; bulk clear (connection_lost) keeps it during relay grace.
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

    // Bump activity on PTY exit, but skip intentional shutdowns (suppressed exits) and click-driven pane unmounts (pendingActivationSpawn).
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
    const rendererShutdownPtyIds = [opts.ptyId]
    const state = get()
    const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(state, worktreeId)
    // Why: pane transports emit renderer PTY ids, not raw exact-stop handles; guard only the identity that can deliver an exit callback.
    const exitGuardPtyIds = [opts.ptyId]
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
      {
        paneKeys,
        captureMode: 'completed-agent-hibernation'
      }
    )
    const retainedCompletionEvidence = collectHibernatedCompletionEvidenceForWorktree(
      state,
      worktreeId,
      paneKeys
    )
    if (!sleepingAgentSessionRecords[opts.paneKey]) {
      // Why: killing the PTY with no persisted resume record strands the pane unwakeable; abort instead of hibernating unrecoverably.
      throw new Error('agent_hibernation_capture_missing')
    }

    const capture = shutdownBufferCaptures.get(opts.tabId)
    if (capture) {
      try {
        capture({ includeLocalBuffers: false })
      } catch {
        // Don't let one tab's capture failure block the pane hibernation.
      }
    }

    // Why: pty:exit can reach the renderer before the kill promise resolves, so the sleeping record must be in the store before the kill (and rolled back on failure).
    const sleepingRecordKeys = Object.keys(sleepingAgentSessionRecords)
    const replacedSleepingRecords: Record<string, (typeof sleepingAgentSessionRecords)[string]> = {}
    for (const key of sleepingRecordKeys) {
      const existing = state.sleepingAgentSessionsByPaneKey[key]
      if (existing) {
        replacedSleepingRecords[key] = existing
      }
    }

    const rollbackTargetShutdownState = (): void => {
      set((s) => {
        const next = { ...s.suppressedPtyExitIds }
        for (const ptyId of exitGuardPtyIds) {
          delete next[ptyId]
        }
        const nextSleeping = { ...s.sleepingAgentSessionsByPaneKey }
        for (const key of sleepingRecordKeys) {
          const replaced = replacedSleepingRecords[key]
          if (replaced) {
            nextSleeping[key] = replaced
          } else {
            delete nextSleeping[key]
          }
        }
        return { suppressedPtyExitIds: next, sleepingAgentSessionsByPaneKey: nextSleeping }
      })
    }

    set((s) => ({
      suppressedPtyExitIds: {
        ...s.suppressedPtyExitIds,
        ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
      },
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        ...sleepingAgentSessionRecords
      }
    }))

    if (expectedRuntimePtyIds.length > 0) {
      if (!runtimeEnvironmentId) {
        rollbackTargetShutdownState()
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
        rollbackTargetShutdownState()
        throw err
      }
      const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
      const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
      const targetWasLive = expectedRuntimePtyIds.every((ptyId) => livePtyIds.includes(ptyId))
      if (!equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) || !targetWasLive) {
        rollbackTargetShutdownState()
        throw new Error('exact_terminal_stop_mismatch')
      }
      if (stopResult.postStopVerified !== true) {
        rollbackTargetShutdownState()
        throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
      }
      for (const snapshot of unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []) {
        snapshot.commit?.()
      }
    } else if (!opts.ptyId.startsWith('remote:')) {
      // Why: pty.kill can flush final data before exit; unregister first so stale handlers can't fire phantom notifications during hibernation.
      const handlerSnapshots = unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []
      try {
        await window.api.pty.kill(opts.ptyId, { keepHistory: true })
      } catch (err) {
        restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
        rollbackTargetShutdownState()
        throw err
      }
      for (const snapshot of handlerSnapshots) {
        snapshot.commit?.()
      }
    }

    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[opts.tabId] ?? []
      const shutdownPtyIdSet = new Set(rendererShutdownPtyIds)
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
      for (const ptyId of exitGuardPtyIds) {
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
          ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
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
    const rendererShutdownPtyIds = sortedUniquePtyIds(ptyIds)
    const expectedRuntimePtyIds = sortedUniquePtyIds(opts?.expectedRuntimePtyIds)
    const runtimeEnvironmentId = resolveTerminalStopRuntimeEnvironmentId(get(), worktreeId)
    // Why: only renderer-bound ids emit pane exit callbacks, so they are the complete guard set (expectedRuntimePtyIds are raw RPC handles).
    const exitGuardPtyIds = rendererShutdownPtyIds
    const sleepingAgentSessionRecords = keepIdentifiers
      ? collectSleepingAgentSessionRecordsForWorktree(get(), worktreeId, {
          paneKeys: opts?.sleepingPaneKeys,
          ...(shutdownReason === 'manual-sleep' ? { captureMode: 'manual-worktree-sleep' } : {}),
          ...(shutdownReason === 'auto-hibernate-completed-agent'
            ? { captureMode: 'completed-agent-hibernation' }
            : {})
        })
      : {}
    const retainedCompletionEvidence =
      shutdownReason === 'auto-hibernate-completed-agent'
        ? collectHibernatedCompletionEvidenceForWorktree(get(), worktreeId, opts?.sleepingPaneKeys)
        : []
    let handlerSnapshots: ReturnType<typeof unregisterPtyDataHandlers> = []
    let partialRendererStopSettled = false
    const markShutdownPending = (): void => {
      set((s) => {
        const nextPending = { ...s.pendingPtyShutdownIds }
        for (const ptyId of exitGuardPtyIds) {
          nextPending[ptyId] = (nextPending[ptyId] ?? 0) + 1
        }
        return {
          suppressedPtyExitIds: {
            ...s.suppressedPtyExitIds,
            ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
          },
          pendingPtyShutdownIds: nextPending
        }
      })
    }
    const rollbackShutdown = (): void => {
      if (handlerSnapshots.length > 0) {
        restorePtyDataHandlersAfterFailedShutdown(handlerSnapshots)
      }
      set((s) => {
        const nextSuppressed = { ...s.suppressedPtyExitIds }
        const nextPending = { ...s.pendingPtyShutdownIds }
        for (const ptyId of exitGuardPtyIds) {
          const remainingOwners = (nextPending[ptyId] ?? 0) - 1
          if (remainingOwners > 0) {
            nextPending[ptyId] = remainingOwners
          } else {
            delete nextPending[ptyId]
            if (!hasCommittedPtyShutdownSettlement(ptyId)) {
              delete nextSuppressed[ptyId]
            }
          }
        }
        return {
          suppressedPtyExitIds: nextSuppressed,
          pendingPtyShutdownIds: nextPending
        }
      })
      const settledPtyIds = exitGuardPtyIds.filter((ptyId) => !get().isPtyShutdownPending(ptyId))
      const committedPtyIds = settledPtyIds.filter(hasCommittedPtyShutdownSettlement)
      const rolledBackPtyIds = settledPtyIds.filter(
        (ptyId) => !hasCommittedPtyShutdownSettlement(ptyId)
      )
      markCommittedPtyShutdowns(committedPtyIds)
      settleDeferredPtyShutdownExits(committedPtyIds, 'committed')
      settleDeferredPtyShutdownExits(rolledBackPtyIds, 'rolled-back')
      clearCommittedPtyShutdownSettlements(settledPtyIds)
    }
    const stopRendererPtys = async (): Promise<{
      stoppedPtyIds: string[]
      failure?: PromiseRejectedResult
    }> => {
      const localPtyIds = rendererShutdownPtyIds.filter((ptyId) => !ptyId.startsWith('remote:'))
      const results = await Promise.allSettled(
        localPtyIds.map((ptyId) => window.api.pty.kill(ptyId, { keepHistory: keepIdentifiers }))
      )
      const stoppedPtyIds = [
        ...(runtimeEnvironmentId
          ? rendererShutdownPtyIds.filter((ptyId) => ptyId.startsWith('remote:'))
          : []),
        ...localPtyIds.filter((_, index) => results[index]?.status === 'fulfilled')
      ]
      disposeParkedTerminalWatchersForPtyIds(stoppedPtyIds)
      return {
        stoppedPtyIds,
        failure: results.find(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        )
      }
    }
    const settlePartialRendererStop = (stoppedPtyIds: readonly string[]): void => {
      partialRendererStopSettled = true
      const stopped = new Set(stoppedPtyIds)
      const stoppedSnapshots = handlerSnapshots.filter((snapshot) => stopped.has(snapshot.ptyId))
      const failedSnapshots = handlerSnapshots.filter((snapshot) => !stopped.has(snapshot.ptyId))
      for (const snapshot of stoppedSnapshots) {
        snapshot.commit?.()
      }
      restorePtyDataHandlersAfterFailedShutdown(failedSnapshots)
      noteCommittedPtyShutdownSettlements(stoppedPtyIds)
      set((s) => {
        const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
        for (const tab of tabs) {
          nextPtyIdsByTabId[tab.id] = (s.ptyIdsByTabId[tab.id] ?? []).filter(
            (ptyId) => !stopped.has(ptyId)
          )
        }
        const nextPending = { ...s.pendingPtyShutdownIds }
        const nextSuppressed = { ...s.suppressedPtyExitIds }
        for (const ptyId of exitGuardPtyIds) {
          const remainingOwners = (nextPending[ptyId] ?? 0) - 1
          if (remainingOwners > 0) {
            nextPending[ptyId] = remainingOwners
          } else {
            delete nextPending[ptyId]
            if (!stopped.has(ptyId)) {
              delete nextSuppressed[ptyId]
            }
          }
        }
        return {
          ptyIdsByTabId: nextPtyIdsByTabId,
          pendingPtyShutdownIds: nextPending,
          suppressedPtyExitIds: nextSuppressed
        }
      })
      const failedPtyIds = exitGuardPtyIds.filter((ptyId) => !stopped.has(ptyId))
      markCommittedPtyShutdowns(stoppedPtyIds)
      settleDeferredPtyShutdownExits(stoppedPtyIds, 'committed')
      settleDeferredPtyShutdownExits(failedPtyIds, 'rolled-back')
      clearCommittedPtyShutdownSettlements(exitGuardPtyIds)
    }

    // Why (ordering invariant, DESIGN_DOC §3.3.c): capture serializer buffers before pty.kill (panes unmount on exit); SSH-critical since the relay drops remote history on kill.
    // Why: capture() writes through the store via setTabLayout, so the set() below must spread s.terminalLayoutsByTabId in a functional updater, not a captured snapshot, or it clobbers the capture.
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

    if (expectedRuntimePtyIds.length === 0) {
      markShutdownPending()
      handlerSnapshots = unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []
      try {
        if (runtimeEnvironmentId) {
          await (shutdownReason === 'manual-sleep'
            ? requestRemoteWorktreeSleep({
                environmentId: runtimeEnvironmentId,
                worktreeId
              })
            : callRuntimeRpc(
                { kind: 'environment', environmentId: runtimeEnvironmentId },
                'terminal.stop',
                { worktree: toRuntimeWorktreeSelector(worktreeId) },
                { timeoutMs: 15_000 }
              ))
        }

        // Why: client-owned teardown waits for the owner RPC so a failure leaves renderer bindings retryable.
        const rendererStop = await stopRendererPtys()
        if (rendererStop.failure) {
          settlePartialRendererStop(rendererStop.stoppedPtyIds)
          throw rendererStop.failure.reason
        }
      } catch (err) {
        if (!partialRendererStopSettled) {
          rollbackShutdown()
        }
        throw err
      }
    }

    if (expectedRuntimePtyIds.length > 0) {
      if (!runtimeEnvironmentId) {
        throw new Error('missing_runtime_for_exact_terminal_stop')
      }
      markShutdownPending()
      handlerSnapshots = unregisterPtyDataHandlers(rendererShutdownPtyIds) ?? []
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
        rollbackShutdown()
        throw err
      }
      const stoppedPtyIds = sortedUniquePtyIds(stopResult.stoppedPtyIds)
      const livePtyIds = sortedUniquePtyIds(stopResult.livePtyIds)
      if (
        !equalStringSets(stoppedPtyIds, expectedRuntimePtyIds) ||
        !equalStringSets(livePtyIds, expectedRuntimePtyIds)
      ) {
        rollbackShutdown()
        throw new Error('exact_terminal_stop_mismatch')
      }
      if (stopResult.postStopVerified !== true) {
        rollbackShutdown()
        throw new Error(stopResult.postStopFailure ?? 'exact_terminal_stop_unverified')
      }
      try {
        const rendererStop = await stopRendererPtys()
        if (rendererStop.failure) {
          settlePartialRendererStop(rendererStop.stoppedPtyIds)
          throw rendererStop.failure.reason
        }
      } catch (err) {
        if (!partialRendererStopSettled) {
          rollbackShutdown()
        }
        throw err
      }
    }

    for (const snapshot of handlerSnapshots) {
      snapshot.commit?.()
    }
    noteCommittedPtyShutdownSettlements(exitGuardPtyIds)

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
        ...Object.fromEntries(exitGuardPtyIds.map((ptyId) => [ptyId, true] as const))
      }
      const nextPendingPtyShutdownIds = { ...s.pendingPtyShutdownIds }
      for (const ptyId of exitGuardPtyIds) {
        const remainingOwners = (nextPendingPtyShutdownIds[ptyId] ?? 0) - 1
        if (remainingOwners > 0) {
          nextPendingPtyShutdownIds[ptyId] = remainingOwners
        } else {
          delete nextPendingPtyShutdownIds[ptyId]
        }
      }
      // Why: keep pendingCodexPaneRestartIds (same ptyId survives sleep→wake), but clear codexRestartNoticeByPtyId since wake's post-spawn ptyId may differ.
      const nextPendingCodexPaneRestartIds = keepIdentifiers
        ? s.pendingCodexPaneRestartIds
        : { ...s.pendingCodexPaneRestartIds }
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of exitGuardPtyIds) {
        if (!keepIdentifiers) {
          delete nextPendingCodexPaneRestartIds[ptyId]
        }
        delete nextCodexRestartNoticeByPtyId[ptyId]
      }
      // Why: setup-split and issue-command-split are transient new-tab one-shots, not sleep-recovery state; clear in both cases.
      const nextPendingSetupSplitByTabId = { ...s.pendingSetupSplitByTabId }
      const nextPendingIssueCommandSplitByTabId = { ...s.pendingIssueCommandSplitByTabId }
      // Why: remove-worktree must clear ptyIdsByLeafId (dead IDs → zombie reattach pane on remount); sleep preserves it so wake can reattach via pty.spawn.
      const nextTerminalLayoutsByTabId = { ...s.terminalLayoutsByTabId }
      // Why: unread dots survive worktree switches, but shutdown/sleep both kill the PTYs behind them, so dead-ptyId unread state is stale — clear in both.
      // Why: preserve the unreadTerminalTabs reference when no shutting-down tab was unread, avoiding a no-op state allocation that re-evaluates selectors.
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

      // Why: remove-worktree kills the relay PTY, so a persisted session ID would fail reattach; sleep preserves it for wake's re-spawn over the relay.
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
        pendingPtyShutdownIds: nextPendingPtyShutdownIds,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        pendingSetupSplitByTabId: nextPendingSetupSplitByTabId,
        pendingIssueCommandSplitByTabId: nextPendingIssueCommandSplitByTabId,
        terminalLayoutsByTabId: nextTerminalLayoutsByTabId,
        // Why: skip writing unreadTerminalTabs when unchanged to avoid a no-op state allocation that re-evaluates full-state selectors. Mirrors tabs.ts.
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
      set((s) => {
        const base =
          shutdownReason === 'manual-sleep'
            ? removeSleepingRecordsReplacedByManualWorktreeSleep(
                s.sleepingAgentSessionsByPaneKey,
                worktreeId,
                opts?.sleepingPaneKeys
              ).records
            : s.sleepingAgentSessionsByPaneKey
        return {
          sleepingAgentSessionsByPaneKey: {
            ...base,
            ...sleepingAgentSessionRecords
          }
        }
      })
    } else {
      get().clearSleepingAgentSessionsByWorktree(worktreeId)
    }

    // Why: only automatic completed-agent sleep keeps passive completion evidence; manual sleep/remove fold the whole worktree surface.
    get().dropAgentStatusByWorktree(worktreeId, {
      shutdownReason,
      sleepingPaneKeys: opts?.sleepingPaneKeys,
      retainedCompletionEvidence
    })
    get().clearPaneForegroundAgentByWorktree(worktreeId)
    const settledPtyIds = exitGuardPtyIds.filter((ptyId) => !get().isPtyShutdownPending(ptyId))
    markCommittedPtyShutdowns(settledPtyIds)
    settleDeferredPtyShutdownExits(settledPtyIds, 'committed')
    clearCommittedPtyShutdownSettlements(settledPtyIds)
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

  isPtyShutdownPending: (ptyId) => (get().pendingPtyShutdownIds[ptyId] ?? 0) > 0,

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

        // Why: a live Codex pane keeps its original launch account until it actually restarts, so A -> B -> A must not leave a stale restart notice.
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

  syncPaneDetachPtyOwnership: ({
    detachedLeafId,
    detachedPtyId,
    sourceLayout,
    sourceTabId,
    targetTabId
  }) => {
    const sourcePaneKey = makePaneKey(sourceTabId, detachedLeafId)
    const targetPaneKey = makePaneKey(targetTabId, detachedLeafId)
    set((s) => {
      const layoutSourcePtyIds = uniquePtyIds(Object.values(sourceLayout.ptyIdsByLeafId ?? {}))
      const existingSourcePtyIds = (s.ptyIdsByTabId[sourceTabId] ?? []).filter(
        (ptyId) => ptyId !== detachedPtyId
      )
      const sourcePtyIds = layoutSourcePtyIds.length > 0 ? layoutSourcePtyIds : existingSourcePtyIds
      const sourcePrimaryPtyId = resolvePrimaryLayoutPtyId(sourceLayout) ?? sourcePtyIds[0] ?? null
      const nextPtyIdsByTabId = {
        ...s.ptyIdsByTabId,
        [sourceTabId]: sourcePtyIds
      }
      if (detachedPtyId) {
        nextPtyIdsByTabId[targetTabId] = uniquePtyIds([
          ...(nextPtyIdsByTabId[targetTabId] ?? []),
          detachedPtyId
        ])
      }

      const nextLastKnownRelayPtyIdByTabId = { ...s.lastKnownRelayPtyIdByTabId }
      if (sourcePrimaryPtyId) {
        nextLastKnownRelayPtyIdByTabId[sourceTabId] = sourcePrimaryPtyId
      } else {
        delete nextLastKnownRelayPtyIdByTabId[sourceTabId]
      }
      if (detachedPtyId) {
        nextLastKnownRelayPtyIdByTabId[targetTabId] = detachedPtyId
      }

      // Why: pane-to-tab detach moves a live PTY without spawning or exiting, so transfer identity without activity bumps.
      const sourceTabsByWorktree = withTerminalTabPtyId(
        s.tabsByWorktree,
        sourceTabId,
        sourcePrimaryPtyId
      )
      const nextTabsByWorktree = detachedPtyId
        ? withTerminalTabPtyId(sourceTabsByWorktree, targetTabId, detachedPtyId)
        : sourceTabsByWorktree

      return {
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelayPtyIdByTabId,
        ...(nextTabsByWorktree !== s.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {})
      }
    })
    // Why: detach keeps the process and its pane key alive, so move resume/status authority to the new surface before the source closes.
    get().transferAgentPaneAuthority({
      fromPaneKey: sourcePaneKey,
      toPaneKey: targetPaneKey,
      ptyId: detachedPtyId
    })
  },

  queueTabStartupCommand: (tabId, startup) => {
    // Why: launchToken is only meaningful for tracked launch-config reuse; plain startup commands must not mint a synthetic token.
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

  queueTabInitialCwd: (tabId, cwd) => {
    set((s) => ({
      pendingInitialCwdByTabId: {
        ...s.pendingInitialCwdByTabId,
        [tabId]: cwd
      }
    }))
  },

  consumeTabInitialCwd: (tabId) => {
    const pending = get().pendingInitialCwdByTabId[tabId]
    if (!pending) {
      return null
    }
    set((s) => {
      const next = { ...s.pendingInitialCwdByTabId }
      delete next[tabId]
      return { pendingInitialCwdByTabId: next }
    })
    return pending
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

  hydrateWorkspaceSession: (session, options) => {
    set((s) => {
      const runtimeSessionPlaceholders = buildRuntimeSessionPlaceholders({
        repos: s.repos,
        runtimeHostIdByWorkspaceSessionKey: options?.runtimeHostIdByWorkspaceSessionKey ?? {},
        worktreesByRepo: s.worktreesByRepo
      })
      const validWorktreeIds = new Set(
        Object.values(runtimeSessionPlaceholders.worktreesByRepo)
          .flat()
          .map((worktree) => worktree.id)
      )
      const knownRepoIds = new Set(runtimeSessionPlaceholders.repos.map((r) => r.id))
      const repoIdsWithLoadedWorktrees = new Set(
        Object.entries(runtimeSessionPlaceholders.worktreesByRepo)
          .filter(([, worktrees]) => worktrees.length > 0)
          .map(([repoId]) => repoId)
      )
      const repoIdsWithAuthoritativeDetectedWorktrees = new Set(
        Object.entries(s.detectedWorktreesByRepo)
          .filter(([, detected]) => detected.authoritative)
          .map(([repoId]) => repoId)
      )
      // Why: the Floating Workspace isn't a repo worktree, but its tabs use the normal session pipeline so daemon PTYs survive app restart.
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
      for (const worktreeId of Object.keys(session.tabsByWorktree)) {
        const parsedWorkspaceKey = parseWorkspaceKey(worktreeId)
        if (parsedWorkspaceKey?.type === 'folder') {
          continue
        }
        if (!validWorktreeIds.has(worktreeId)) {
          const repoId = getRepoIdFromWorktreeId(worktreeId)
          // Why (#1158): an empty/missing list can mean degraded hydration; a non-empty repo list is authoritative for deleted-worktree cleanup.
          if (
            knownRepoIds.has(repoId) &&
            !repoIdsWithLoadedWorktrees.has(repoId) &&
            !repoIdsWithAuthoritativeDetectedWorktrees.has(repoId)
          ) {
            validWorktreeIds.add(worktreeId)
          }
        }
      }
      // Why pendingActivationSpawn: a restored worktree's first mount calls updateTabPtyId, which would bump lastActivityAt and bounce it to the top of Recent; the tag (consumed on the first pty update) suppresses that so only real activity bumps.
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
                  // Why: old web-client mirrors could persist host surface ids with "::"; makePaneKey reserves ":" as its separator.
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
      const fallbackActiveWorktreeId =
        !session.activeWorktreeId && session.activeRepoId && knownRepoIds.has(session.activeRepoId)
          ? (runtimeSessionPlaceholders.worktreesByRepo[session.activeRepoId]?.find(
              (worktree) => worktree.isMainWorktree
            )?.id ??
            runtimeSessionPlaceholders.worktreesByRepo[session.activeRepoId]?.[0]?.id ??
            null)
          : null
      const activeWorktreeId = (() => {
        if (session.activeWorktreeId && validWorktreeIds.has(session.activeWorktreeId)) {
          return session.activeWorktreeId
        }
        // Why: a workspace with no tabs is still valid; fall back from the active repo to avoid a blank landing screen when tabs were pruned or never created.
        return fallbackActiveWorktreeId
      })()
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
        session.activeRepoId &&
        runtimeSessionPlaceholders.repos.some((repo) => repo.id === session.activeRepoId)
          ? session.activeRepoId
          : null

      // Why: workspaceSessionReady stays false here; reconnectPersistedTerminals sets it true after eager spawns so TerminalPane can't mount and spawn duplicate PTYs first.
      // Why: activeWorktreeIdsOnShutdown is authoritative when present; persisted tab/layout PTY IDs are only wake hints, not a full active-workspace list.
      const shutdownIds =
        session.activeWorktreeIdsOnShutdown ??
        Object.entries(session.tabsByWorktree)
          .filter(([, tabs]) => tabs.some((t) => t.ptyId))
          .map(([wId]) => wId)
      const pendingReconnectWorktreeIds = shutdownIds.filter((id) => validWorktreeIds.has(id))

      // Why: record which tabs had live PTYs from raw session data before clearTransientTerminalState nulls ptyIds, so reconnect binds the right tabs in multi-tab worktrees (not just tabs[0]).
      // Also include tabs whose relay session id survived in remoteSessionIdsByTabId (ptyId was null but the relay PTY is alive).
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

      // Why: preserve each tab's prior ptyId so reconnect passes it as sessionId to the daemon's createOrAttach, triggering reattach instead of a fresh spawn.
      const pendingReconnectPtyIdByTabId: Record<string, string> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const worktree = Object.values(runtimeSessionPlaceholders.worktreesByRepo)
          .flat()
          .find((entry) => entry.id === worktreeId)
        const repo = worktree
          ? runtimeSessionPlaceholders.repos.find((entry) => entry.id === worktree.repoId)
          : null
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

      // Why: remote PTY reattach uses the relay's pty.attach RPC, not the local daemon; the loop above skips SSH repos, so no overlap.
      for (const [tabId, sessionId] of Object.entries(remoteSessionIds)) {
        if (validTabIds.has(tabId)) {
          pendingReconnectPtyIdByTabId[tabId] = sessionId
        }
      }

      // Restore per-worktree active tab; validate ids when the map exists, else derive for legacy sessions.
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

      // Why: SSH worktrees aren't persisted in worktreesByRepo (discovered via relay); synthesize placeholders from session tabs so the sidebar shows them until SSH reconnect + fetchWorktrees replace them.
      // Why: only SSH gets placeholders; local metadata comes from the next successful fetch.
      const sshRepoIds = new Set(
        runtimeSessionPlaceholders.repos.filter((r) => r.connectionId).map((r) => r.id)
      )
      const worktreesByRepo = { ...runtimeSessionPlaceholders.worktreesByRepo }
      for (const worktreeId of Object.keys(tabsByWorktree)) {
        const repoId = getRepoIdFromWorktreeId(worktreeId)
        if (!sshRepoIds.has(repoId)) {
          continue
        }
        const existing = (worktreesByRepo[repoId] ?? []).find((w) => w.id === worktreeId)
        if (existing) {
          continue
        }
        // Why: strip the synthetic `::workspace:<uuid>` folder suffix so the placeholder path is a real cwd; `id` above keeps it for identity.
        const path = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? ''
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

      // Why: the restored-active worktree bypasses setActiveWorktree, so record it in everActivatedWorktreeIds here to keep a later re-click from re-tagging (which would suppress real activity).
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
        restoredRuntimeHostIdByWorkspaceSessionKey:
          options?.runtimeHostIdByWorkspaceSessionKey ?? {},
        repos: runtimeSessionPlaceholders.repos,
        tabsByWorktree,
        worktreesByRepo,
        // Why: restore the focus-recency map; pruning is deferred to App.tsx (post-hydration) because SSH worktrees may still be appearing in worktreesByRepo.
        lastVisitedAtByWorktreeId: session.lastVisitedAtByWorktreeId ?? {},
        defaultTerminalTabsAppliedByWorktreeId:
          session.defaultTerminalTabsAppliedByWorktreeId ?? {},
        automaticAgentResumeClaimsByTabId: {},
        sleepingAgentSessionsByPaneKey,
        pendingReconnectWorktreeIds,
        pendingReconnectTabByWorktree,
        pendingReconnectPtyIdByTabId,
        everActivatedWorktreeIds: nextEverActivated,
        // Why: seed nav history with the hydrated active worktree so the first activation has a Back target; hydration bypasses recordWorktreeVisit, so otherwise Back stays disabled until a second click.
        worktreeNavHistory: activeWorktreeId ? [activeWorktreeId] : [],
        worktreeNavHistoryIndex: activeWorktreeId ? 0 : -1,
        ptyIdsByTabId: Object.fromEntries(
          Object.values(tabsByWorktree)
            .flat()
            .map((tab) => [tab.id, []] as const)
        ),
        // Why: daemon ptyIds survive app restart; preserve ptyIdsByLeafId so reconnect can reattach each split-pane leaf to its own session, not just the tab-level ptyId.
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId)
            .filter(([tabId]) => validTabIds.has(tabId))
            .map(([tabId, layout]) => {
              // Why: old sessions can contain renderer-local pane:1-style leaf ids; normalize before runtime/mobile surfaces read them.
              const normalized = normalizeTerminalLayoutSnapshot(layout).snapshot
              const tab = Object.values(tabsByWorktree)
                .flat()
                .find((entry) => entry.id === tabId)
              const sanitized = tab ? sanitizeTerminalLayoutPaneTitles(normalized, tab) : normalized
              const activeLeafId = sanitized.root
                ? resolvePtyBoundActiveLeafId({
                    root: sanitized.root,
                    activeLeafId: sanitized.activeLeafId,
                    ptyIdsByLeafId: sanitized.ptyIdsByLeafId
                  })
                : sanitized.activeLeafId
              return [tabId, { ...sanitized, activeLeafId }]
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
      tabsByWorktree,
      ptyIdsByTabId
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

    // Why: defer daemon createOrAttach to connectPanePty (real fitAddon dims) instead of eager-spawning at 80×24 and garbling on flush; this loop only records the session IDs to reattach.
    let reconnectedTabsByWorktree: Record<string, TerminalTab[]> | null = null
    let reconnectedPtyIdsByTabId: Record<string, string[]> | null = null
    for (const worktreeId of ids) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      const repo = worktree ? get().repos.find((entry) => entry.id === worktree.repoId) : null
      // Why: only allow deferred reattach when the SSH connection is active; reattaching to a not-yet-connected relay (deferred/passphrase targets) would fail.
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

        // Why: set the wake-hint (tab.ptyId) and live-pty map (ptyIdsByTabId) so the worktree dot goes green before the pane mounts; actual reattach happens later in pty-connection.ts.
        console.debug(
          `[reconnect-terminals] tab=${tabId} tabLevelPtyId=${tabLevelPtyId} supportsDeferredReattach=${supportsDeferredReattach} hasLeafMappings=${hasLeafMappings}`
        )
        if (tabLevelPtyId) {
          reconnectedTabsByWorktree ??= { ...tabsByWorktree }
          const nextTabs = reconnectedTabsByWorktree[worktreeId]
          if (!nextTabs) {
            continue
          }

          // Why: populate ptyIdsByTabId so the sessions status segment maps daemon IDs to tabs; otherwise all sessions look like orphans until the pane mounts.
          const allPtyIds = hasLeafMappings
            ? (Object.values(leafPtyMap).filter(Boolean) as string[])
            : [tabLevelPtyId]
          reconnectedTabsByWorktree[worktreeId] = nextTabs.map((t) =>
            t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t
          )
          // Why: hide-sleeping reads ptyIdsByTabId for liveness; restored daemon sessions run before their pane remounts, so advertise them.
          reconnectedPtyIdsByTabId ??= { ...ptyIdsByTabId }
          reconnectedPtyIdsByTabId[tabId] = allPtyIds
        }
      }
    }

    // Why: deferred SSH targets haven't connected yet, so their ptyIds weren't restored above; stash session IDs in a map that survives cleanup for pty-connection.ts's deferred reconnect.
    const deferredSshSessionIdsByTabId: Record<string, string> = {}
    for (const worktreeId of ids) {
      const worktree = Object.values(get().worktreesByRepo)
        .flat()
        .find((entry) => entry.id === worktreeId)
      // Why: SSH worktrees aren't in worktreesByRepo at cold start; fall back to the repo id in the composite worktree id so sessions still reach the deferred map.
      const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
      const repo = repoId ? get().repos.find((entry) => entry.id === repoId) : null
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
      ...(reconnectedTabsByWorktree ? { tabsByWorktree: reconnectedTabsByWorktree } : {}),
      ...(reconnectedPtyIdsByTabId ? { ptyIdsByTabId: reconnectedPtyIdsByTabId } : {}),
      workspaceSessionReady: true,
      pendingReconnectWorktreeIds: [],
      pendingReconnectTabByWorktree: {},
      pendingReconnectPtyIdByTabId: {},
      deferredSshSessionIdsByTabId
    })
  }
})
