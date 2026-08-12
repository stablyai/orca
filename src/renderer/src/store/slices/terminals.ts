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
import type { DirectSshAuthority } from '../../../../shared/ssh-types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
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
import { isDecorativeAgentTitleFrameChange } from '../../../../shared/agent-decorative-title-signature'
import {
  isTerminalLeafId,
  makePaneKey,
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../../shared/stable-pane-id'
import { isValidHostTerminalTabId } from '../../../../shared/terminal-tab-id'
import { buildByIdIndex, buildWorktreeByIdIndex } from './worktree-by-id-index'
import { resolveActiveTabOwnerWorktreeId } from './active-tab-owner-worktree'
import { isSameCodexRestartNoticeAccount } from './codex-restart-notice-account-identity'
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
import type { AiVaultSessionTitle } from '../../../../shared/ai-vault-session-title'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { forgetAgentHibernationTabOutput } from '@/lib/agent-hibernation-output-activity'
import { forgetForegroundTerminalTabs } from '@/lib/foreground-terminal-tabs'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'
import { forgetAgentStartupDeliveriesForTabs } from '@/lib/agent-startup-delivery-guards'
import { clearTransientTerminalState, emptyLayoutSnapshot } from './terminal-helpers'
import {
  collectReleasedLeafIds,
  hydrateWorkspaceTerminalRows,
  releaseTerminalLayoutPtyIds
} from './terminal-session-row-hydration'
import {
  getRecentlyClosedTabPosition,
  pushClosedTerminalTabSnapshot,
  pushRecentlyClosedTabKind
} from './recently-closed-tabs'
import { isClaudeAgent } from '@/lib/agent-status'
import { recordTerminalInputActivity } from '@/lib/terminal-input-activity-coalescing'
import { classifyTitleActivity } from '@/lib/pane-agent-evidence'
import { buildOrphanTerminalCleanupPatch, getOrphanTerminalIds } from './terminal-orphan-helpers'
import {
  applyGeneratedTabTitleUpdates,
  applyTerminalTabTitleUpdates,
  type GeneratedTabTitleUpdate,
  type TerminalTabTitleUpdate
} from './terminal-tab-title-batch'
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
import {
  normalizeTerminalLayoutPtyOwnership,
  resolveTerminalLayoutPtyOwnershipTransfers
} from '@/components/terminal-pane/terminal-layout-pty-ownership'
import { shutdownBufferCaptures } from '@/components/terminal-pane/shutdown-buffer-captures'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { parseRemoteRuntimePtyId, toRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { requestRemoteWorktreeSleep } from '@/runtime/remote-worktree-sleep'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getFolderWorkspaceConnectionId } from '@/lib/folder-workspace-connection'
import {
  clearDirectSshTerminalBindings,
  invalidateStaleDirectSshTerminalBindings,
  type DirectSshLivePtyBinding,
  type DirectSshPaneRetryAttempt,
  type DirectSshPaneRetryAttemptId,
  type DirectSshPaneRetryHistory,
  type DirectSshPaneRetryResult
} from './direct-ssh-terminal-recovery'
import {
  retryDirectSshTerminalPanes,
  retrySettledDirectSshTerminalPane
} from './direct-ssh-pane-retry-ledger'
import {
  directSshAuthoritiesEqual,
  settleDirectSshPaneRetryState,
  transferDirectSshPaneDetachLedger
} from './direct-ssh-terminal-authority-ledger'
import { resolveDirectSshTerminalWorkspaceKeys } from './direct-ssh-terminal-workspace-scope'
import { hasWorktreeSleepIntent } from '@/lib/worktree-sleep-intent'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { resolveTerminalWorktreeRoute } from '@/lib/terminal-worktree-route'
import { resolveWorktreeOperationRouteResult } from '@/lib/worktree-operation-route'
import { isWebClientLocation } from '@/lib/web-client-location'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import type { NativeChatLaunchDraft, NativeChatLaunchPrompt } from '@/lib/native-chat-launch-prompt'
import { resolveAgentPaneAuthorityKey } from './agent-pane-authority'
import {
  addAdditionalValidWorkspaceKeys,
  type WorkspaceSessionHydrationOptions
} from '@/lib/workspace-session-hydration-keys'
import {
  buildValidWorktreeIdsForSessionHydration,
  collectPersistedWorktreeIdsForSessionHydration
} from './degraded-repo-worktree-validity'
import {
  collectHibernatedCompletionEvidenceForWorktree,
  collectSleepingAgentSessionRecordsForWorktree,
  removeSleepingRecordsReplacedByManualWorktreeSleep,
  type AgentStatusWorktreeShutdownReason
} from './agent-status'
import {
  buildTerminalTabRetirementPlan,
  classifyTerminalRetirementWorktree,
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

function isCurrentDirectSshAuthority(state: AppState, authority: DirectSshAuthority): boolean {
  const current = state.sshConnectionStates.get(authority.targetId)
  return Boolean(
    current?.status === 'connected' &&
    current.providerEpoch === authority.providerEpoch &&
    current.connectionGeneration === authority.connectionGeneration
  )
}

function resolveDirectSshTerminalKeys(state: AppState, targetId: string): Set<string> {
  return resolveDirectSshTerminalWorkspaceKeys(
    {
      targetId,
      catalogRevision: 0,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo,
      detectedWorktreesByRepo: state.detectedWorktreesByRepo,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      restoredRuntimeHostIdByWorkspaceSessionKey: state.restoredRuntimeHostIdByWorkspaceSessionKey
    },
    state.tabsByWorktree,
    state.lastKnownRelayPtyIdByTabId
  )
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

export type CodexRestartNotice = {
  previousAccountLabel: string
  nextAccountLabel: string
  /** Ids behind the two labels, when the caller knows them (`null` is the system
   *  default). Two accounts can share a label, so only these can decide whether
   *  a re-mark actually points back at the account the pane launched under. */
  previousAccountId?: string | null
  nextAccountId?: string | null
  /** The launch account still matches, but its baked CODEX_HOME route is retired. */
  homeRouteChanged?: true
  /** Set once the user asks for the restart. The record outlives the prompt
   *  because the previous-account fields are the only memory of the account this
   *  pane actually launched under, which drives the A -> B -> A collapse. */
  restartRequested?: true
  /** Set when the user answers "Keep old account". Same reason the record has to
   *  survive: deleting it erased the launch account, so re-selecting it looked
   *  like a fresh switch and raised an inverted prompt that killed pane input. */
  dismissed?: true
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
  codexRestartNoticeByPtyId: Record<string, CodexRestartNotice>
  directSshPaneRetryByTabId: Record<string, DirectSshPaneRetryAttempt>
  directSshLivePtyBindingByTabId: Record<string, DirectSshLivePtyBinding>
  directSshPaneRetryHistoryByTabId: Record<string, DirectSshPaneRetryHistory>
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
  /** Launch context prefilled into the TUI input as an unsent draft; the chat composer adopts it. In-memory only. */
  nativeChatLaunchDraftByTabId: Record<string, NativeChatLaunchDraft>
  seedNativeChatLaunchDraft: (draft: NativeChatLaunchDraft) => void
  markNativeChatLaunchDraftAdopted: (tabId: string) => void
  resolveNativeChatLaunchDraft: (
    tabId: string,
    resolution: Pick<NativeChatLaunchDraft, 'createdAt' | 'text'>
  ) => void
  clearNativeChatLaunchDraft: (tabId: string) => void
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
      forceHostRuntime?: boolean
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
  updateTabTitles: (updates: readonly TerminalTabTitleUpdate[]) => void
  setAiVaultTabTitle: (tabId: string, aiVaultTitle: AiVaultSessionTitle | null) => void
  setGeneratedTabTitleFromAgentPrompt: (
    paneKey: string,
    prompt: string,
    options?: { replaceExistingGeneratedTitle?: boolean }
  ) => void
  setGeneratedTabTitlesFromAgentPrompts: (updates: readonly GeneratedTabTitleUpdate[]) => void
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
  updateTabPtyId: (
    tabId: string,
    ptyId: string,
    replacedPtyId?: string,
    directSshRetryAttemptId?: DirectSshPaneRetryAttemptId
  ) => void
  clearTabPtyId: (tabId: string, ptyId?: string) => void
  clearDirectSshTargetPtyBindings: (targetId: string) => number
  invalidateStaleDirectSshTargetPtyBindings: (authority: DirectSshAuthority) => number
  retryDirectSshTargetPanes: (authority: DirectSshAuthority, now?: number) => number
  settleDirectSshPaneRetry: (result: DirectSshPaneRetryResult, now?: number) => void
  shutdownWorktreeTerminals: (
    worktreeId: string,
    opts?: {
      keepIdentifiers?: boolean
      shutdownReason?: AgentStatusWorktreeShutdownReason
      sleepingPaneKeys?: string[]
      expectedRuntimePtyIds?: string[]
      /** Opt-in for callers that already tore the workspace down backend-side; omitting it keeps the runtime stop. */
      backendOwnsPtyTeardown?: boolean
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
  /** Returns the ptyIds left holding a notice, so callers can tell a raised
   *  prompt from one the A -> B -> A collapse dropped. */
  markCodexRestartNotices: (
    notices: (Pick<CodexRestartNotice, 'previousAccountLabel' | 'nextAccountLabel'> &
      Partial<Pick<CodexRestartNotice, 'previousAccountId' | 'nextAccountId'>> & {
        /** Explicit false replaces a restored route notice after main rechecks it. */
        homeRouteChanged?: boolean
        ptyId: string
      })[]
  ) => string[]
  clearCodexRestartNotice: (ptyId: string) => void
  dismissCodexRestartNotices: (ptyIds: string[]) => void
  /** Puts an accepted-but-unexecuted restart back to the unanswered prompt, so a
   *  failed execution never leaves a pane input-blocked with nothing visible. */
  reopenCodexRestartPrompt: (ptyId: string) => void
  /** Rebinds one layout leaf to a replacement PTY without a mounted pane. */
  replaceTerminalLayoutPanePtyId: (tabId: string, leafId: string, ptyId: string) => void
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
  reconnectPersistedTerminals: (
    signal?: AbortSignal,
    options?: ReconnectPersistedTerminalsOptions
  ) => Promise<void>
}

export type HydrateWorkspaceSessionOptions = {
  directSshAuthority?: DirectSshAuthority
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
} & WorkspaceSessionHydrationOptions

export type ReconnectPersistedTerminalsOptions = {
  directSshAuthority: DirectSshAuthority
  workspaceKeys: readonly string[]
}

type WorkspaceHydrationPatch = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'activeWorkspaceKey'
  | 'activeWorkspaceExecutionHostId'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'restoredRuntimeHostIdByWorkspaceSessionKey'
  | 'repos'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
  | 'lastVisitedAtByWorktreeId'
  | 'defaultTerminalTabsAppliedByWorktreeId'
  | 'automaticAgentResumeClaimsByTabId'
  | 'sleepingAgentSessionsByPaneKey'
  | 'pendingReconnectWorktreeIds'
  | 'pendingReconnectTabByWorktree'
  | 'pendingReconnectPtyIdByTabId'
  | 'everActivatedWorktreeIds'
  | 'worktreeNavHistory'
  | 'worktreeNavHistoryIndex'
  | 'ptyIdsByTabId'
  | 'terminalLayoutsByTabId'
>

function replaceHydratedRecordKeys<T>(
  current: Record<string, T>,
  hydrated: Record<string, T>,
  replaceKeys: ReadonlySet<string>
): Record<string, T> {
  return {
    ...Object.fromEntries(Object.entries(current).filter(([key]) => !replaceKeys.has(key))),
    ...Object.fromEntries(Object.entries(hydrated).filter(([key]) => replaceKeys.has(key)))
  }
}

type TerminalLayoutPtyOwnershipTransfer = ReturnType<
  typeof resolveTerminalLayoutPtyOwnershipTransfers
>[number]

function transferNormalizedTerminalLayoutPtyOwnership(
  state: Pick<AppState, 'terminalLayoutsByTabId' | 'transferAgentPaneAuthority'>,
  tabId: string,
  transfers: readonly TerminalLayoutPtyOwnershipTransfer[]
): void {
  if (transfers.length === 0) {
    return
  }
  const ptyIdsOwnedByOtherTabs = new Set<string>()
  for (const [candidateTabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (candidateTabId === tabId) {
      continue
    }
    for (const ptyId of Object.values(layout.ptyIdsByLeafId ?? {})) {
      ptyIdsOwnedByOtherTabs.add(ptyId)
    }
  }
  for (const { removedLeafId, retainedLeafId, ptyId } of transfers) {
    if (
      !isTerminalLeafId(removedLeafId) ||
      !isTerminalLeafId(retainedLeafId) ||
      ptyIdsOwnedByOtherTabs.has(ptyId)
    ) {
      continue
    }
    const fromPaneKey = makePaneKey(tabId, removedLeafId)
    const currentOwner = parsePaneKey(resolveAgentPaneAuthorityKey(fromPaneKey))
    if (currentOwner && currentOwner.tabId !== tabId) {
      continue
    }
    state.transferAgentPaneAuthority({
      fromPaneKey,
      toPaneKey: makePaneKey(tabId, retainedLeafId),
      ptyId
    })
  }
}

function targetScopedWorkspaceHydrationPatch(
  state: AppState,
  hydrated: WorkspaceHydrationPatch,
  session: WorkspaceSessionState,
  options: HydrateWorkspaceSessionOptions
): Partial<AppState> {
  const workspaceKeys = new Set(options.replaceWorkspaceKeys)
  const targetTabIds = new Set(
    [...workspaceKeys].flatMap((workspaceKey) => [
      ...(state.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id),
      ...(session.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
    ])
  )
  const retainedTargetTabIds = new Set(
    [...workspaceKeys].flatMap((workspaceKey) =>
      (hydrated.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
    )
  )
  const deletedTargetTabIds = new Set(
    [...workspaceKeys]
      .flatMap((workspaceKey) => (state.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id))
      .filter((tabId) => !retainedTargetTabIds.has(tabId))
  )
  const pendingReconnectPtyIdByTabId = replaceHydratedRecordKeys(
    state.pendingReconnectPtyIdByTabId,
    {},
    targetTabIds
  )
  const authority = options.directSshAuthority
  if (authority) {
    for (const workspaceKey of hydrated.pendingReconnectWorktreeIds) {
      if (!workspaceKeys.has(workspaceKey)) {
        continue
      }
      for (const tab of session.tabsByWorktree[workspaceKey] ?? []) {
        // Why: rows hydration dropped (invalid id, canonical duplicate) would leak reconnect keys nothing owns.
        if (!retainedTargetTabIds.has(tab.id)) {
          continue
        }
        const ptyId = session.remoteSessionIdsByTabId?.[tab.id] ?? tab.ptyId
        if (ptyId && parseAppSshPtyId(ptyId)?.connectionId === authority.targetId) {
          pendingReconnectPtyIdByTabId[tab.id] = ptyId
        }
      }
    }
  }
  const activeOutsideScope =
    state.activeWorktreeId != null && !workspaceKeys.has(state.activeWorktreeId)
  const sleepingAgentSessionsByPaneKey = Object.fromEntries([
    ...Object.entries(state.sleepingAgentSessionsByPaneKey).filter(
      ([, record]) => !workspaceKeys.has(record.worktreeId)
    ),
    ...Object.entries(hydrated.sleepingAgentSessionsByPaneKey).filter(([, record]) =>
      workspaceKeys.has(record.worktreeId)
    )
  ])
  const everActivatedWorktreeIds = new Set(state.everActivatedWorktreeIds)
  for (const workspaceKey of hydrated.everActivatedWorktreeIds) {
    if (workspaceKeys.has(workspaceKey)) {
      everActivatedWorktreeIds.add(workspaceKey)
    }
  }
  return {
    activeRepoId: activeOutsideScope ? state.activeRepoId : hydrated.activeRepoId,
    activeWorktreeId: activeOutsideScope ? state.activeWorktreeId : hydrated.activeWorktreeId,
    activeWorkspaceKey: activeOutsideScope ? state.activeWorkspaceKey : hydrated.activeWorkspaceKey,
    activeWorkspaceExecutionHostId: activeOutsideScope
      ? state.activeWorkspaceExecutionHostId
      : hydrated.activeWorkspaceExecutionHostId,
    activeTabId: activeOutsideScope ? state.activeTabId : hydrated.activeTabId,
    activeTabIdByWorktree: replaceHydratedRecordKeys(
      state.activeTabIdByWorktree,
      hydrated.activeTabIdByWorktree,
      workspaceKeys
    ),
    tabsByWorktree: replaceHydratedRecordKeys(
      state.tabsByWorktree,
      hydrated.tabsByWorktree,
      workspaceKeys
    ),
    lastVisitedAtByWorktreeId: replaceHydratedRecordKeys(
      state.lastVisitedAtByWorktreeId,
      hydrated.lastVisitedAtByWorktreeId,
      workspaceKeys
    ),
    defaultTerminalTabsAppliedByWorktreeId: replaceHydratedRecordKeys(
      state.defaultTerminalTabsAppliedByWorktreeId,
      hydrated.defaultTerminalTabsAppliedByWorktreeId,
      workspaceKeys
    ),
    automaticAgentResumeClaimsByTabId: replaceHydratedRecordKeys(
      state.automaticAgentResumeClaimsByTabId,
      hydrated.automaticAgentResumeClaimsByTabId,
      targetTabIds
    ),
    sleepingAgentSessionsByPaneKey,
    pendingReconnectWorktreeIds: [
      ...state.pendingReconnectWorktreeIds.filter((key) => !workspaceKeys.has(key)),
      ...hydrated.pendingReconnectWorktreeIds.filter((key) => workspaceKeys.has(key))
    ],
    pendingReconnectTabByWorktree: replaceHydratedRecordKeys(
      state.pendingReconnectTabByWorktree,
      hydrated.pendingReconnectTabByWorktree,
      workspaceKeys
    ),
    pendingReconnectPtyIdByTabId,
    everActivatedWorktreeIds,
    directSshPaneRetryByTabId: replaceHydratedRecordKeys(
      state.directSshPaneRetryByTabId,
      {},
      deletedTargetTabIds
    ),
    directSshLivePtyBindingByTabId: replaceHydratedRecordKeys(
      state.directSshLivePtyBindingByTabId,
      {},
      deletedTargetTabIds
    ),
    directSshPaneRetryHistoryByTabId: replaceHydratedRecordKeys(
      state.directSshPaneRetryHistoryByTabId,
      {},
      deletedTargetTabIds
    ),
    ptyIdsByTabId: replaceHydratedRecordKeys(
      state.ptyIdsByTabId,
      hydrated.ptyIdsByTabId,
      targetTabIds
    ),
    terminalLayoutsByTabId: replaceHydratedRecordKeys(
      state.terminalLayoutsByTabId,
      hydrated.terminalLayoutsByTabId,
      targetTabIds
    )
  }
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
  pendingPtyShutdownIds: {},
  pendingCodexPaneRestartIds: {},
  codexRestartNoticeByPtyId: {},
  directSshPaneRetryByTabId: {},
  directSshLivePtyBindingByTabId: {},
  directSshPaneRetryHistoryByTabId: {},
  expandedPaneByTabId: {},
  canExpandPaneByTabId: {},
  terminalLayoutsByTabId: {},
  pendingStartupByTabId: {},
  pendingInitialCwdByTabId: {},
  pendingSetupSplitByTabId: {},
  pendingIssueCommandSplitByTabId: {},
  automaticAgentResumeClaimsByTabId: {},
  nativeChatLaunchPromptByTabId: {},
  nativeChatLaunchDraftByTabId: {},
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

  seedNativeChatLaunchDraft: (draft) => {
    set((s) => ({
      nativeChatLaunchDraftByTabId: {
        ...s.nativeChatLaunchDraftByTabId,
        [draft.tabId]: draft
      }
    }))
  },

  markNativeChatLaunchDraftAdopted: (tabId) => {
    set((s) => {
      const current = s.nativeChatLaunchDraftByTabId[tabId]
      if (!current || current.adopted) {
        return {}
      }
      return {
        nativeChatLaunchDraftByTabId: {
          ...s.nativeChatLaunchDraftByTabId,
          [tabId]: { ...current, adopted: true }
        }
      }
    })
  },

  resolveNativeChatLaunchDraft: (tabId, resolution) => {
    set((s) => {
      const current = s.nativeChatLaunchDraftByTabId[tabId]
      if (
        !current ||
        current.resolved ||
        current.createdAt !== resolution.createdAt ||
        current.text !== resolution.text
      ) {
        return {}
      }
      return {
        nativeChatLaunchDraftByTabId: {
          ...s.nativeChatLaunchDraftByTabId,
          [tabId]: { ...current, resolved: true }
        }
      }
    })
  },

  clearNativeChatLaunchDraft: (tabId) => {
    set((s) => {
      if (!s.nativeChatLaunchDraftByTabId[tabId]) {
        return {}
      }
      const next = { ...s.nativeChatLaunchDraftByTabId }
      delete next[tabId]
      return { nativeChatLaunchDraftByTabId: next }
    })
  },

  recordTerminalInput: (paneKey, timestamp = Date.now()) => {
    if (!paneKey || !Number.isFinite(timestamp)) {
      return
    }
    recordTerminalInputActivity({
      paneKey,
      timestamp,
      // Why: the first stamp for a pane must land synchronously; automation take-over
      // detection subscribes and compares undefined→value across a launch.
      forceWrite: get().lastTerminalInputAtByPaneKey[paneKey] === undefined,
      commit: {
        insert: (key, at) =>
          set((s) => ({
            lastTerminalInputAtByPaneKey: { ...s.lastTerminalInputAtByPaneKey, [key]: at }
          })),
        refreshExisting: (entries) =>
          set((s) => {
            let next: Record<string, number> | null = null
            for (const [key, at] of entries) {
              // Why: teardown (close pane/tab/worktree purge) deletes keys; a late flush must not resurrect them.
              const current = s.lastTerminalInputAtByPaneKey[key]
              if (current === undefined || current >= at) {
                continue
              }
              next ??= { ...s.lastTerminalInputAtByPaneKey }
              next[key] = at
            }
            return next ? { lastTerminalInputAtByPaneKey: next } : {}
          })
      }
    })
  },

  setCacheTimerStartedAt: (key, ts) => {
    set((s) => {
      // Why: a real pane write clears any ':seed' sentinel from seedCacheTimersForIdleTabs, avoiding phantom timers when the seed key doesn't match the real pane.
      const colonIdx = key.indexOf(':')
      const suffix = colonIdx === -1 ? null : key.slice(colonIdx + 1)
      const seedKey = colonIdx !== -1 && suffix !== 'seed' ? `${key.slice(0, colonIdx)}:seed` : null
      const hasStaleSeed = seedKey !== null && seedKey in s.cacheTimerByKey
      // Why: parked-pane watchers replay null-over-null on every working/exit transition; each redundant write runs every subscriber's selector.
      if (s.cacheTimerByKey[key] === ts && !hasStaleSeed) {
        return s
      }
      const next = { ...s.cacheTimerByKey, [key]: ts }
      if (seedKey !== null) {
        delete next[seedKey]
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
        isRemoteWorktree || options?.forceHostRuntime
          ? undefined
          : getLocalProjectExecutionRuntimeContext(s, worktreeId)
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
        ...(options?.forceHostRuntime ? { forceHostRuntime: true } : {}),
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
    if (isWebClientLocation() && worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
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
        // Why: log the worktree SHAPE, never the id — worktree ids embed absolute paths. The old
        // "runtime handles" wording described ids that are usually plain local ones, hiding STA-2639.
        console.warn('[terminal-retirement] skipped PTYs with no resolvable owner', {
          tabId,
          worktreeKind: classifyTerminalRetirementWorktree(retirementPlan.worktreeId),
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
      const closedPosition =
        closedWorktreeId && closedTab
          ? getRecentlyClosedTabPosition(s, closedWorktreeId, closedTab.id)
          : undefined
      const capturedSnapshot =
        closeReason === 'user' &&
        opts?.captureRecentlyClosed !== false &&
        closedTab &&
        closedWorktreeId
          ? {
              ...(closedTab.startupCwd ? { startupCwd: closedTab.startupCwd } : {}),
              ...(closedTab.shellOverride ? { shellOverride: closedTab.shellOverride } : {}),
              ...(closedTab.customTitle ? { customTitle: closedTab.customTitle } : {}),
              ...(closedTab.color ? { color: closedTab.color } : {}),
              ...(closedPosition ? { position: closedPosition } : {})
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
      const nextDirectSshPaneRetryByTabId = { ...s.directSshPaneRetryByTabId }
      delete nextDirectSshPaneRetryByTabId[tabId]
      const nextDirectSshLivePtyBindingByTabId = {
        ...s.directSshLivePtyBindingByTabId
      }
      delete nextDirectSshLivePtyBindingByTabId[tabId]
      const nextDirectSshPaneRetryHistoryByTabId = {
        ...s.directSshPaneRetryHistoryByTabId
      }
      delete nextDirectSshPaneRetryHistoryByTabId[tabId]
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
      const nextNativeChatLaunchDraftByTabId = { ...s.nativeChatLaunchDraftByTabId }
      delete nextNativeChatLaunchDraftByTabId[tabId]
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
        directSshPaneRetryByTabId: nextDirectSshPaneRetryByTabId,
        directSshLivePtyBindingByTabId: nextDirectSshLivePtyBindingByTabId,
        directSshPaneRetryHistoryByTabId: nextDirectSshPaneRetryHistoryByTabId,
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
        nativeChatLaunchDraftByTabId: nextNativeChatLaunchDraftByTabId,
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
    // Why: sweep tab agent status through its suppressor-aware removal path.
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
    let tabOwnerWorktreeId: string | null = null
    set((s) => {
      // Why: clear bells only for visible tabs; background bells must persist.
      tabOwnerWorktreeId = resolveActiveTabOwnerWorktreeId(
        s.tabsByWorktree,
        s.activeWorktreeId,
        tabId
      )
      const isActiveWorktreeTab =
        tabOwnerWorktreeId !== null && tabOwnerWorktreeId === s.activeWorktreeId
      const nextUnreadTerminalTabs =
        isActiveWorktreeTab && s.unreadTerminalTabs[tabId]
          ? (() => {
              const copy = { ...s.unreadTerminalTabs }
              delete copy[tabId]
              return copy
            })()
          : s.unreadTerminalTabs
      // Why: activeTabId marks the visible tab, so background bells remain unread.
      return {
        activeTabId: isActiveWorktreeTab ? tabId : s.activeTabId,
        // Why: a redundant activation must not reallocate this map — Terminal's
        // active-terminal repair effect depends on it, so a re-activation that
        // can't converge activeTabId (tab id reused by an earlier-scanned
        // worktree) would otherwise re-trigger itself into React error #185.
        activeTabIdByWorktree:
          tabOwnerWorktreeId !== null && s.activeTabIdByWorktree[tabOwnerWorktreeId] !== tabId
            ? { ...s.activeTabIdByWorktree, [tabOwnerWorktreeId]: tabId }
            : s.activeTabIdByWorktree,
        unreadTerminalTabs: nextUnreadTerminalTabs
      }
    })
    const state = get()
    const ownerUnifiedTabs =
      tabOwnerWorktreeId !== null && Object.hasOwn(state.unifiedTabsByWorktree, tabOwnerWorktreeId)
        ? state.unifiedTabsByWorktree[tabOwnerWorktreeId]
        : []
    // Why: a duplicated entity id must activate the same owner chosen above.
    const item =
      ownerUnifiedTabs.find(
        (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
      ) ??
      Object.values(state.unifiedTabsByWorktree)
        .flat()
        .find((entry) => entry.contentType === 'terminal' && entry.entityId === tabId)
    if (item) {
      state.activateTab(
        item.id,
        tabOwnerWorktreeId !== null ? { worktreeId: tabOwnerWorktreeId } : undefined
      )
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
    set((state) => {
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
      const ownerByTabId = ownerWorktreeId
        ? new Map([[tabId, ownerWorktreeId]])
        : new Map<string, string>()
      const result = applyTerminalTabTitleUpdates(state, [{ tabId, title }], ownerByTabId)
      if (result.runtimeGraphChanged) {
        scheduleRuntimeGraphSync()
      }
      return result.patch ?? state
    })
  },

  updateTabTitles: (updates) => {
    if (updates.length === 0) {
      return
    }
    set((state) => {
      const result = applyTerminalTabTitleUpdates(state, updates)
      if (result.runtimeGraphChanged) {
        scheduleRuntimeGraphSync()
      }
      return result.patch ?? state
    })
  },

  setAiVaultTabTitle: (tabId, aiVaultTitle) => {
    set((s) => {
      const ownerWorktreeId = getTerminalTabOwnerWorktreeId(s.tabsByWorktree, tabId)
      if (!ownerWorktreeId) {
        return s
      }
      const tabs = s.tabsByWorktree[ownerWorktreeId] ?? []
      const current = tabs.find((tab) => tab.id === tabId)
      const sameTitle =
        current?.aiVaultTitle?.agent === aiVaultTitle?.agent &&
        current?.aiVaultTitle?.sessionId === aiVaultTitle?.sessionId &&
        current?.aiVaultTitle?.title === aiVaultTitle?.title
      if (!current || sameTitle) {
        return s
      }
      const ownerTabs = tabs.map((tab) => (tab.id === tabId ? { ...tab, aiVaultTitle } : tab))
      const unifiedTabs = s.unifiedTabsByWorktree[ownerWorktreeId] ?? []
      const nextUnifiedTabs = unifiedTabs.map((tab) =>
        tab.contentType === 'terminal' && tab.entityId === tabId ? { ...tab, aiVaultTitle } : tab
      )
      scheduleRuntimeGraphSync()
      return {
        tabsByWorktree: { ...s.tabsByWorktree, [ownerWorktreeId]: ownerTabs },
        unifiedTabsByWorktree: {
          ...s.unifiedTabsByWorktree,
          [ownerWorktreeId]: nextUnifiedTabs
        }
      }
    })
  },

  setGeneratedTabTitleFromAgentPrompt: (paneKey, prompt, options) => {
    // Why: setAgentStatus is high-frequency; skip derive/set unless the feature is on and this tab still needs a (re)generated title.
    const state = get()
    const tabId = getTabIdFromPaneKey(paneKey)
    if (!tabId || prompt.length === 0 || state.settings?.tabAutoGenerateTitle !== true) {
      return
    }
    const ownerWorktreeId = getTerminalTabOwnerWorktreeId(state.tabsByWorktree, tabId)
    if (!ownerWorktreeId) {
      return
    }
    const tabs = state.tabsByWorktree[ownerWorktreeId] ?? []
    const currentTab = tabs.find((tab) => tab.id === tabId)
    if (!currentTab || currentTab.customTitle?.trim() || currentTab.quickCommandLabel?.trim()) {
      return
    }
    const existingGeneratedTitle = currentTab.generatedTitle?.trim()
    if (existingGeneratedTitle && options?.replaceExistingGeneratedTitle !== true) {
      return
    }
    set((latestState) => {
      const result = applyGeneratedTabTitleUpdates(
        latestState,
        [{ paneKey, prompt, options }],
        new Map([[tabId, ownerWorktreeId]])
      )
      if (result.runtimeGraphChanged) {
        scheduleRuntimeGraphSync()
      }
      return result.patch ?? latestState
    })
  },

  setGeneratedTabTitlesFromAgentPrompts: (updates) => {
    if (updates.length === 0) {
      return
    }
    set((state) => {
      const result = applyGeneratedTabTitleUpdates(state, updates)
      if (result.runtimeGraphChanged) {
        scheduleRuntimeGraphSync()
      }
      return result.patch ?? state
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
      // Why: re-sort hookless title changes only when their activity classification changes.
      const classificationChanged =
        classifyTitleActivity(prevTitle ?? '') !== classifyTitleActivity(title)
      // Why: skip active-worktree remount side effects and orphaned panes.
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
    // Why: terminal attention persists until real interaction.
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

  updateTabPtyId: (tabId, ptyId, replacedPtyId, directSshRetryAttemptId) => {
    // Why: final guard preventing a late caller from recreating retired tab maps (async spawn owners still do their own provider teardown).
    if (!isTerminalTabPresent(get(), tabId)) {
      return
    }
    let worktreeId: string | null = null
    let wasActivationSpawn = false
    const isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
    set((s) => {
      if (directSshRetryAttemptId) {
        const pendingRetry = s.directSshPaneRetryByTabId[tabId]
        const liveRetry = s.directSshLivePtyBindingByTabId[tabId]
        const retryLease =
          pendingRetry?.attemptId === directSshRetryAttemptId
            ? pendingRetry
            : liveRetry?.attemptId === directSshRetryAttemptId
              ? liveRetry
              : undefined
        const boundTab = Object.values(s.tabsByWorktree)
          .flat()
          .find((candidate) => candidate.id === tabId)
        if (
          !retryLease ||
          !boundTab ||
          parseAppSshPtyId(ptyId)?.connectionId !== retryLease.authority.targetId ||
          !isCurrentDirectSshAuthority(s, retryLease.authority) ||
          (boundTab.generation ?? 0) !== retryLease.tabGeneration
        ) {
          return s
        }
      }
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
        // Why: consume one suppression per split-pane activation callback.
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
      // Why: the first active PTY changes sorting, except activation-spawn side effects.
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
      const pendingRetry = s.directSshPaneRetryByTabId[tabId]
      const liveRetry = s.directSshLivePtyBindingByTabId[tabId]
      const retryLease =
        pendingRetry?.attemptId === directSshRetryAttemptId
          ? pendingRetry
          : liveRetry?.attemptId === directSshRetryAttemptId
            ? liveRetry
            : undefined
      const boundTab = worktreeId
        ? nextTabsByWorktree[worktreeId]?.find((candidate) => candidate.id === tabId)
        : undefined
      const parsedSshPty = parseAppSshPtyId(ptyId)
      const acknowledgesDirectSshRetry = Boolean(
        retryLease &&
        boundTab &&
        parsedSshPty?.connectionId === retryLease.authority.targetId &&
        isCurrentDirectSshAuthority(s, retryLease.authority) &&
        (boundTab.generation ?? 0) === retryLease.tabGeneration &&
        nextPtyIds.includes(ptyId)
      )
      let nextDirectSshPaneRetryByTabId = s.directSshPaneRetryByTabId
      let nextDirectSshLivePtyBindingByTabId = s.directSshLivePtyBindingByTabId
      if (acknowledgesDirectSshRetry && retryLease && boundTab?.ptyId) {
        if (pendingRetry?.attemptId === directSshRetryAttemptId) {
          nextDirectSshPaneRetryByTabId = { ...s.directSshPaneRetryByTabId }
          delete nextDirectSshPaneRetryByTabId[tabId]
        }
        if (!liveRetry || liveRetry.attemptId !== directSshRetryAttemptId) {
          nextDirectSshLivePtyBindingByTabId = {
            ...s.directSshLivePtyBindingByTabId,
            [tabId]: {
              attemptId: retryLease.attemptId,
              authority: retryLease.authority,
              tabGeneration: retryLease.tabGeneration,
              ptyId: boundTab.ptyId
            }
          }
        } else if (
          (replacementPtyId === liveRetry.ptyId && boundTab.ptyId === ptyId) ||
          !nextPtyIds.includes(liveRetry.ptyId)
        ) {
          nextDirectSshLivePtyBindingByTabId = {
            ...s.directSshLivePtyBindingByTabId,
            [tabId]: { ...liveRetry, ptyId: boundTab.ptyId }
          }
        }
      } else {
        const liveBinding = s.directSshLivePtyBindingByTabId[tabId]
        if (liveBinding) {
          if (
            replacementPtyId === liveBinding.ptyId &&
            boundTab?.ptyId === ptyId &&
            isCurrentDirectSshAuthority(s, liveBinding.authority)
          ) {
            nextDirectSshLivePtyBindingByTabId = {
              ...s.directSshLivePtyBindingByTabId,
              [tabId]: { ...liveBinding, ptyId }
            }
          }
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
        directSshPaneRetryByTabId: nextDirectSshPaneRetryByTabId,
        directSshLivePtyBindingByTabId: nextDirectSshLivePtyBindingByTabId,
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
    let preservesDirectSshContinuationGap = false
    let isRemoteRuntimeMirror = isRemoteRuntimePtyId(ptyId)
    set((s) => {
      const existingPtyIds = s.ptyIdsByTabId[tabId] ?? []
      const remainingPtyIds = ptyId ? existingPtyIds.filter((id) => id !== ptyId) : []
      const liveBinding = s.directSshLivePtyBindingByTabId[tabId]
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
        preservesDirectSshContinuationGap = Boolean(
          ptyId &&
          remainingPtyIds.length === 0 &&
          liveBinding?.ptyId === ptyId &&
          getPendingActivationSpawnCount(tab.pendingActivationSpawn) > 0 &&
          isCurrentDirectSshAuthority(s, liveBinding.authority)
        )
        const shouldRetainActivationSpawn =
          preservesDirectSshContinuationGap ||
          (wasActivationSpawn && ptyId != null && !existingPtyIds.includes(ptyId))
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
      // Why: an explicit exit drops the dead relay ID; bulk clears retain it for relay grace.
      const nextLastKnownRelay = { ...s.lastKnownRelayPtyIdByTabId }
      if (ptyId && nextLastKnownRelay[tabId] === ptyId) {
        // Why: the relay slot holds ONE id per tab (the last pane to bind). If
        // that pane exits, promote a surviving pane instead of clearing — else the
        // survivor is left visible only in the layout leaf map, and a later
        // relay-drop bulk-clear lets the orphan sweep delete the still-live tab
        // (the orphan predicate reads this map but not layout leaves) (#9911).
        const survivingPtyId = remainingPtyIds.at(-1)
        if (survivingPtyId) {
          nextLastKnownRelay[tabId] = survivingPtyId
        } else {
          delete nextLastKnownRelay[tabId]
        }
      }
      let nextDirectSshPaneRetryByTabId = s.directSshPaneRetryByTabId
      const pendingRetry = s.directSshPaneRetryByTabId[tabId]
      if (
        pendingRetry &&
        (!ptyId ||
          (existingPtyIds.includes(ptyId) &&
            parseAppSshPtyId(ptyId)?.connectionId === pendingRetry.authority.targetId))
      ) {
        nextDirectSshPaneRetryByTabId = { ...s.directSshPaneRetryByTabId }
        delete nextDirectSshPaneRetryByTabId[tabId]
      }
      let nextDirectSshLivePtyBindingByTabId = s.directSshLivePtyBindingByTabId
      if (liveBinding && (!ptyId || liveBinding.ptyId === ptyId)) {
        nextDirectSshLivePtyBindingByTabId = {
          ...s.directSshLivePtyBindingByTabId
        }
        const promotedPtyId = ptyId ? remainingPtyIds.at(-1) : undefined
        if (
          promotedPtyId &&
          parseAppSshPtyId(promotedPtyId)?.connectionId === liveBinding.authority.targetId &&
          isCurrentDirectSshAuthority(s, liveBinding.authority)
        ) {
          nextDirectSshLivePtyBindingByTabId[tabId] = {
            ...liveBinding,
            ptyId: promotedPtyId
          }
        } else if (!preservesDirectSshContinuationGap) {
          delete nextDirectSshLivePtyBindingByTabId[tabId]
        }
      }

      return {
        ...(nextTabsByWorktree !== s.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelay,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds,
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId,
        directSshPaneRetryByTabId: nextDirectSshPaneRetryByTabId,
        directSshLivePtyBindingByTabId: nextDirectSshLivePtyBindingByTabId
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

    // Why: store sleeping records before kill, since pty:exit can arrive first.
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

  clearDirectSshTargetPtyBindings: (targetId) => {
    let clearedCount = 0
    set((s) => {
      const result = clearDirectSshTerminalBindings(s, resolveDirectSshTerminalKeys(s, targetId))
      clearedCount = result.clearedCount
      return result.patch ?? s
    })
    return clearedCount
  },

  invalidateStaleDirectSshTargetPtyBindings: (authority) => {
    let clearedCount = 0
    set((s) => {
      if (!isCurrentDirectSshAuthority(s, authority)) {
        return s
      }
      const result = invalidateStaleDirectSshTerminalBindings(
        s,
        resolveDirectSshTerminalKeys(s, authority.targetId),
        authority
      )
      clearedCount = result.clearedCount
      return result.patch ?? s
    })
    return clearedCount
  },

  retryDirectSshTargetPanes: (authority, now = Date.now()) => {
    let retriedCount = 0
    set((s) => {
      if (!isCurrentDirectSshAuthority(s, authority)) {
        return s
      }
      const result = retryDirectSshTerminalPanes(
        s,
        resolveDirectSshTerminalKeys(s, authority.targetId),
        authority,
        now
      )
      retriedCount = result.retriedCount
      return result.patch ?? s
    })
    return retriedCount
  },

  settleDirectSshPaneRetry: (result, now = Date.now()) => {
    set((s) => {
      if (!isCurrentDirectSshAuthority(s, result.authority)) {
        return s
      }
      const history = s.directSshPaneRetryHistoryByTabId[result.tabId]
      const preservesExhaustedSplitAttempt =
        (result.status === 'failed' || result.status === 'timed-out') &&
        history != null &&
        directSshAuthoritiesEqual(history.authority, result.authority) &&
        history.attemptedAt.length >= 2
      if (preservesExhaustedSplitAttempt) {
        return s
      }
      const settlement = settleDirectSshPaneRetryState(s, result)
      if (!settlement) {
        return s
      }
      const settledState = { ...s, ...settlement }
      if (result.status !== 'failed' && result.status !== 'timed-out') {
        return settledState
      }
      const retry = retrySettledDirectSshTerminalPane(
        settledState,
        resolveDirectSshTerminalKeys(settledState, result.authority.targetId),
        result.authority,
        result.tabId,
        now
      )
      return retry.patch ? { ...settledState, ...retry.patch } : settledState
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

    // Why: capture buffers before kill, which unmounts panes and drops SSH relay history.
    // Why: capture() updates layouts, so the following updater must merge current state.
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
        // Why an opt-in, not the reason: defaulting to the stop keeps callers without backend teardown from leaking remote PTYs.
        if (runtimeEnvironmentId && opts?.backendOwnsPtyTeardown !== true) {
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

    // Exact-stop callers own physical teardown and must not use the remove-worktree reason.
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
                opts?.sleepingPaneKeys,
                sleepingAgentSessionRecords
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
    set((s) => {
      // Why: the prompt is answered the moment the user asks for a restart. A
      // pane whose tab isn't mounted can only restart when it next mounts, and
      // leaving the prompt up re-showed a button that now does nothing.
      const nextCodexRestartNoticeByPtyId = { ...s.codexRestartNoticeByPtyId }
      for (const ptyId of ptyIds) {
        const notice = nextCodexRestartNoticeByPtyId[ptyId]
        if (notice) {
          // Why: mirror of the strip in dismissCodexRestartNotices. A queued
          // restart leaves the pane on the old account until it relaunches, so
          // it must re-block input that an earlier dismissal had freed.
          const { dismissed: _dismissed, ...kept } = notice
          nextCodexRestartNoticeByPtyId[ptyId] = { ...kept, restartRequested: true }
        }
      }
      return {
        pendingCodexPaneRestartIds: {
          ...s.pendingCodexPaneRestartIds,
          ...Object.fromEntries(ptyIds.map((ptyId) => [ptyId, true] as const))
        },
        codexRestartNoticeByPtyId: nextCodexRestartNoticeByPtyId
      }
    })
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
      return []
    }
    const noticedPtyIds: string[] = []
    set((s) => {
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      for (const notice of notices) {
        const existing = next[notice.ptyId]
        // Why one record rather than two lookups: the label and the id of the
        // launch account have to come from the same source, or they can end up
        // describing two different accounts.
        const launch = existing ?? notice
        const target = { id: notice.nextAccountId, label: notice.nextAccountLabel }
        const homeRouteChanged =
          notice.homeRouteChanged === undefined
            ? existing?.homeRouteChanged === true
            : notice.homeRouteChanged

        // Why: a live Codex pane keeps its original launch account until it actually restarts, so A -> B -> A must not leave a stale restart notice.
        if (
          !homeRouteChanged &&
          isSameCodexRestartNoticeAccount(
            { id: launch.previousAccountId, label: launch.previousAccountLabel },
            target
          )
        ) {
          delete next[notice.ptyId]
          delete nextPendingCodexPaneRestartIds[notice.ptyId]
          continue
        }

        next[notice.ptyId] = {
          previousAccountLabel: launch.previousAccountLabel,
          nextAccountLabel: notice.nextAccountLabel,
          ...(launch.previousAccountId === undefined
            ? {}
            : { previousAccountId: launch.previousAccountId }),
          ...(notice.nextAccountId === undefined ? {} : { nextAccountId: notice.nextAccountId }),
          ...(homeRouteChanged ? { homeRouteChanged: true as const } : {}),
          // Why: a queued restart relaunches under whatever account is selected
          // when it runs, so a later switch does not reopen an answered prompt.
          ...(existing?.restartRequested ? { restartRequested: true as const } : {}),
          // Why: a dismissal answered one question — "keep the launch account
          // instead of this one". Only a genuinely different target re-asks it,
          // so a later C reopens the prompt while adding an account or
          // reauthenticating the active one (both re-mark live panes with the
          // selection unchanged) must not resurrect it and re-mute the pane.
          ...(existing?.dismissed &&
          isSameCodexRestartNoticeAccount(
            { id: existing.nextAccountId, label: existing.nextAccountLabel },
            target
          )
            ? { dismissed: true as const }
            : {})
        }
        noticedPtyIds.push(notice.ptyId)
      }
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
    return noticedPtyIds
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

  dismissCodexRestartNotices: (ptyIds) => {
    set((s) => {
      // Why: keeping the old account is an answer, not a restart — the record
      // stays so `previousAccountLabel` still names the pane's launch account,
      // but every consumer treats it as answered (prompt hidden, input freed).
      const next = { ...s.codexRestartNoticeByPtyId }
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      let changed = false
      for (const ptyId of ptyIds) {
        const notice = next[ptyId]
        if (!notice || notice.dismissed) {
          continue
        }
        const { restartRequested: _restartRequested, ...kept } = notice
        next[ptyId] = { ...kept, dismissed: true }
        delete nextPendingCodexPaneRestartIds[ptyId]
        changed = true
      }
      if (!changed) {
        return {}
      }
      return {
        codexRestartNoticeByPtyId: next,
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  reopenCodexRestartPrompt: (ptyId) => {
    set((s) => {
      const notice = s.codexRestartNoticeByPtyId[ptyId]
      if (!notice?.restartRequested) {
        return {}
      }
      const { restartRequested: _restartRequested, ...kept } = notice
      const nextPendingCodexPaneRestartIds = { ...s.pendingCodexPaneRestartIds }
      delete nextPendingCodexPaneRestartIds[ptyId]
      return {
        codexRestartNoticeByPtyId: { ...s.codexRestartNoticeByPtyId, [ptyId]: kept },
        pendingCodexPaneRestartIds: nextPendingCodexPaneRestartIds
      }
    })
  },

  replaceTerminalLayoutPanePtyId: (tabId, leafId, ptyId) => {
    set((s) => {
      const layout = s.terminalLayoutsByTabId[tabId]
      if (!layout || layout.ptyIdsByLeafId?.[leafId] === ptyId) {
        return {}
      }
      return {
        terminalLayoutsByTabId: {
          ...s.terminalLayoutsByTabId,
          [tabId]: {
            ...layout,
            ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId }
          }
        }
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
    let ownershipTransfers: ReturnType<typeof resolveTerminalLayoutPtyOwnershipTransfers> = []
    set((s) => {
      if (!layout) {
        if (!(tabId in s.terminalLayoutsByTabId)) {
          return s
        }
        const next = { ...s.terminalLayoutsByTabId }
        delete next[tabId]
        return { terminalLayoutsByTabId: next }
      }
      const normalized = normalizeTerminalLayoutPtyOwnership(layout)
      // Resolved before the bailout: normalization can transfer pane ownership even when the stored snapshot is untouched.
      if (normalized.changed) {
        ownershipTransfers = resolveTerminalLayoutPtyOwnershipTransfers(layout, normalized.snapshot)
      }
      // Why: pane-title churn re-persists structurally identical snapshots; bailing keeps every pane selector asleep.
      const existing = s.terminalLayoutsByTabId[tabId]
      if (existing && terminalLayoutEqual(existing, normalized.snapshot)) {
        return s
      }
      return {
        terminalLayoutsByTabId: { ...s.terminalLayoutsByTabId, [tabId]: normalized.snapshot }
      }
    })
    transferNormalizedTerminalLayoutPtyOwnership(get(), tabId, ownershipTransfers)
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
      const directSshLedger = transferDirectSshPaneDetachLedger(s, {
        detachedPtyId,
        sourcePtyId: sourcePrimaryPtyId,
        sourceTabId,
        targetTabId,
        isAuthorityCurrent: (authority) => isCurrentDirectSshAuthority(s, authority)
      })

      return {
        ptyIdsByTabId: nextPtyIdsByTabId,
        lastKnownRelayPtyIdByTabId: nextLastKnownRelayPtyIdByTabId,
        ...directSshLedger,
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
    const ownershipTransferTabIds = options?.replaceWorkspaceKeys
      ? new Set(
          options.replaceWorkspaceKeys.flatMap((workspaceKey) =>
            (session.tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
          )
        )
      : null
    const ownershipTransfersByTabId = new Map<string, TerminalLayoutPtyOwnershipTransfer[]>()
    set((s) => {
      const runtimeSessionPlaceholders = buildRuntimeSessionPlaceholders({
        repos: s.repos,
        runtimeHostIdByWorkspaceSessionKey: options?.runtimeHostIdByWorkspaceSessionKey ?? {},
        worktreesByRepo: s.worktreesByRepo
      })
      const validWorktreeIds = buildValidWorktreeIdsForSessionHydration(
        {
          repos: runtimeSessionPlaceholders.repos,
          worktreesByRepo: runtimeSessionPlaceholders.worktreesByRepo,
          detectedWorktreesByRepo: s.detectedWorktreesByRepo
        },
        collectPersistedWorktreeIdsForSessionHydration(session)
      )
      const knownRepoIds = new Set(runtimeSessionPlaceholders.repos.map((r) => r.id))
      // Why: the Floating Workspace isn't a repo worktree, but its tabs use the normal session pipeline so daemon PTYs survive app restart.
      validWorktreeIds.add(FLOATING_TERMINAL_WORKTREE_ID)
      for (const workspace of s.folderWorkspaces) {
        validWorktreeIds.add(folderWorkspaceKey(workspace.id))
      }
      addAdditionalValidWorkspaceKeys(validWorktreeIds, options)
      // Why: rows for these keys came off the remote wire, which carries no unifiedTabs, so the
      // session's canonical list describes a different snapshot and must not arbitrate their PTYs.
      const remoteSnapshotWorkspaceKeys = new Set(
        options?.directSshAuthority ? (options.replaceWorkspaceKeys ?? []) : []
      )
      const rowHydrationByWorktree = Object.entries(session.tabsByWorktree)
        .filter(([worktreeId]) => validWorktreeIds.has(worktreeId))
        .map(
          ([worktreeId, tabs]) =>
            [
              worktreeId,
              hydrateWorkspaceTerminalRows(session, worktreeId, tabs, {
                rowsFromRemoteSnapshot: remoteSnapshotWorkspaceKeys.has(worktreeId)
              })
            ] as const
        )
      const tabsByWorktree: Record<string, TerminalTab[]> = Object.fromEntries(
        rowHydrationByWorktree
          .map(([worktreeId, hydration]) => [worktreeId, hydration.rows] as const)
          .filter(([, tabs]) => tabs.length > 0)
      )
      const releasedPtyIdsByTabId = new Map<string, Set<string>>(
        rowHydrationByWorktree.flatMap(([, hydration]) => [...hydration.releasedPtyIdsByTabId])
      )
      const reconnectPtyIdByRetainedTabId = new Map<string, string>(
        rowHydrationByWorktree.flatMap(([, hydration]) => [
          ...hydration.reconnectPtyIdByRetainedTabId
        ])
      )
      const canonicalTabIdBySubsumedTabId = new Map<string, string>(
        rowHydrationByWorktree.flatMap(([, hydration]) => [
          ...hydration.canonicalTabIdBySubsumedTabId
        ])
      )

      const validTabIds = new Set(
        Object.values(tabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )
      let sleepingAgentSessionsByPaneKey = Object.fromEntries(
        Object.entries(session.sleepingAgentSessionsByPaneKey ?? {}).filter(([, record]) =>
          validWorktreeIds.has(record.worktreeId)
        )
      )
      // Why: a dropped row is never retired, so nothing else clears the sleeping records keyed to
      // it — its worktree is still valid — and the workspace keeps a pane nobody can wake.
      for (const [, hydration] of rowHydrationByWorktree) {
        for (const tabId of [...hydration.subsumedTabIds, ...hydration.invalidTabIds]) {
          sleepingAgentSessionsByPaneKey = removeSleepingAgentSessionsForTab(
            sleepingAgentSessionsByPaneKey,
            tabId
          )
        }
      }
      // Why: a released leaf's agent session belongs to the canonical row now; leaving the record here
      // would cold-restore the same provider session on a pane that no longer owns its PTY.
      const releasedPaneKeys = new Set<string>(
        [...releasedPtyIdsByTabId].flatMap(([tabId, releasedPtyIds]) =>
          collectReleasedLeafIds(session.terminalLayoutsByTabId[tabId], releasedPtyIds)
            // Why: persisted ptyIdsByLeafId keys are unvalidated strings, and makePaneKey throws on non-UUIDs.
            .filter(isTerminalLeafId)
            .map((leafId) => makePaneKey(tabId, leafId))
        )
      )
      if (releasedPaneKeys.size > 0) {
        sleepingAgentSessionsByPaneKey = Object.fromEntries(
          Object.entries(sleepingAgentSessionsByPaneKey).filter(
            ([paneKey]) => !releasedPaneKeys.has(paneKey)
          )
        )
      }
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
      const activeWorkspaceExecutionHostId =
        activeWorkspaceKey && session.activeWorkspaceExecutionHostId
          ? session.activeWorkspaceExecutionHostId
          : null
      // Why: follow a subsumed row to the canonical twin that inherited its PTY, else the app
      // restarts with no active terminal even though the same session is still mounted.
      const restoredActiveTabId = session.activeTabId
        ? (canonicalTabIdBySubsumedTabId.get(session.activeTabId) ?? session.activeTabId)
        : null
      const activeTabId =
        restoredActiveTabId && validTabIds.has(restoredActiveTabId) ? restoredActiveTabId : null
      const activeRepoId =
        session.activeRepoId &&
        runtimeSessionPlaceholders.repos.some((repo) => repo.id === session.activeRepoId)
          ? session.activeRepoId
          : null

      // Why: reconnect enables the session after eager spawns to prevent duplicate PTYs.
      // Why: activeWorktreeIdsOnShutdown is authoritative when present; persisted tab/layout PTY IDs are only wake hints, not a full active-workspace list.
      const shutdownIds =
        session.activeWorktreeIdsOnShutdown ??
        Object.entries(session.tabsByWorktree)
          .filter(([, tabs]) => tabs.some((t) => t.ptyId))
          .map(([wId]) => wId)
      const pendingReconnectWorktreeIds = shutdownIds.filter((id) => validWorktreeIds.has(id))

      // Why: capture live PTY tabs before transient state clears their IDs.
      // Also include tabs whose relay session id survived in remoteSessionIdsByTabId (ptyId was null but the relay PTY is alive).
      const remoteSessionIds = session.remoteSessionIdsByTabId ?? {}
      const pendingReconnectTabByWorktree: Record<string, string[]> = {}
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        const liveTabIds = rawTabs
          .filter(
            (t) =>
              // Why: a row that gave its tab-level PTY to the canonical twin still owns leaf sessions to advertise.
              (t.ptyId || remoteSessionIds[t.id] || reconnectPtyIdByRetainedTabId.has(t.id)) &&
              validTabIds.has(t.id)
          )
          .map((t) => t.id)
        if (liveTabIds.length > 0) {
          pendingReconnectTabByWorktree[worktreeId] = liveTabIds
        }
      }

      // Why: preserve each tab's prior ptyId so reconnect passes it as sessionId to the daemon's createOrAttach, triggering reattach instead of a fresh spawn.
      const pendingReconnectPtyIdByTabId: Record<string, string> = {}
      const placeholderWorktreeById = buildWorktreeByIdIndex(
        runtimeSessionPlaceholders.worktreesByRepo
      )
      const placeholderRepoById = buildByIdIndex(runtimeSessionPlaceholders.repos)
      for (const worktreeId of pendingReconnectWorktreeIds) {
        const worktree = placeholderWorktreeById.get(worktreeId)
        const repo = worktree ? placeholderRepoById.get(worktree.repoId) : null
        if (repo?.connectionId) {
          continue
        }
        const rawTabs = session.tabsByWorktree[worktreeId] ?? []
        for (const tab of rawTabs) {
          // Why: a released PTY belongs to the canonical row now; reattaching it here would restore the duplicate ownership.
          if (
            tab.ptyId &&
            validTabIds.has(tab.id) &&
            !releasedPtyIdsByTabId.get(tab.id)?.has(tab.ptyId)
          ) {
            pendingReconnectPtyIdByTabId[tab.id] = tab.ptyId
          }
        }
      }

      // Why: remote PTY reattach uses the relay's pty.attach RPC, not the local daemon; the loop above skips SSH repos, so no overlap.
      for (const [tabId, sessionId] of Object.entries(remoteSessionIds)) {
        if (validTabIds.has(tabId) && !releasedPtyIdsByTabId.get(tabId)?.has(sessionId)) {
          pendingReconnectPtyIdByTabId[tabId] = sessionId
        }
      }

      // Why: hydration nulls tab.ptyId and orphan detection ignores layout bindings, so a row whose
      // tab-level PTY went to its canonical twin reads as dead and is swept before its own surviving
      // pane can reattach. Anchor it on the PTY it still owns (#10486).
      for (const [tabId, ptyId] of reconnectPtyIdByRetainedTabId) {
        if (validTabIds.has(tabId) && !pendingReconnectPtyIdByTabId[tabId]) {
          pendingReconnectPtyIdByTabId[tabId] = ptyId
        }
      }

      // Restore per-worktree active tab; validate ids when the map exists, else derive for legacy sessions.
      let activeTabIdByWorktree: Record<string, string | null> = {}
      if (session.activeTabIdByWorktree) {
        for (const [wId, tabId] of Object.entries(session.activeTabIdByWorktree)) {
          if (!validWorktreeIds.has(wId) || !tabId) {
            continue
          }
          // Why: a subsumed row's canonical twin holds the same PTY, so follow the pointer there
          // instead of forgetting which terminal the workspace last focused.
          const restored = validTabIds.has(tabId) ? tabId : canonicalTabIdBySubsumedTabId.get(tabId)
          if (restored && validTabIds.has(restored)) {
            activeTabIdByWorktree[wId] = restored
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

      // Why: synthesize SSH worktrees from session tabs until relay discovery replaces them.
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

      // Why: record restored active worktrees to avoid suppressing later real activity.
      const nextEverActivated = new Set(s.everActivatedWorktreeIds)
      if (activeWorktreeId) {
        nextEverActivated.add(activeWorktreeId)
      }

      // Why indexed: the layout map below looks up a tab per persisted layout, and
      // re-flattening tabsByWorktree per entry is O(tabs x layouts).
      const allTabs = Object.values(tabsByWorktree).flat()
      const tabById = buildByIdIndex(allTabs)

      const hydrated: WorkspaceHydrationPatch = {
        activeRepoId,
        activeWorktreeId,
        activeWorkspaceKey,
        activeWorkspaceExecutionHostId,
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
        // Why: seed hydrated active worktrees so the first activation has a Back target.
        worktreeNavHistory: activeWorktreeId ? [activeWorktreeId] : [],
        worktreeNavHistoryIndex: activeWorktreeId ? 0 : -1,
        ptyIdsByTabId: Object.fromEntries(allTabs.map((tab) => [tab.id, []] as const)),
        // Why: preserve daemon leaf PTY IDs to reattach every split-pane session.
        terminalLayoutsByTabId: Object.fromEntries(
          Object.entries(session.terminalLayoutsByTabId)
            .filter(([tabId]) => validTabIds.has(tabId))
            .map(([tabId, persisted]) => {
              const releasedPtyIds = releasedPtyIdsByTabId.get(tabId)
              const layout = releasedPtyIds
                ? releaseTerminalLayoutPtyIds(persisted, releasedPtyIds)
                : persisted
              // Why: old sessions can contain renderer-local pane:1-style leaf ids; normalize before runtime/mobile surfaces read them.
              const normalization = normalizeTerminalLayoutSnapshot(layout)
              const normalized = normalization.snapshot
              if (
                normalization.changed &&
                (!ownershipTransferTabIds || ownershipTransferTabIds.has(tabId))
              ) {
                ownershipTransfersByTabId.set(
                  tabId,
                  resolveTerminalLayoutPtyOwnershipTransfers(layout, normalized)
                )
              }
              const tab = tabById.get(tabId)
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
      return options?.replaceWorkspaceKeys
        ? targetScopedWorkspaceHydrationPatch(s, hydrated, session, options)
        : hydrated
    })
    for (const [tabId, transfers] of ownershipTransfersByTabId) {
      transferNormalizedTerminalLayoutPtyOwnership(get(), tabId, transfers)
    }
  },

  reconnectPersistedTerminals: async (signal, options) => {
    if (
      signal?.aborted ||
      (options && !isCurrentDirectSshAuthority(get(), options.directSshAuthority))
    ) {
      return
    }
    const {
      pendingReconnectWorktreeIds,
      pendingReconnectTabByWorktree,
      pendingReconnectPtyIdByTabId,
      terminalLayoutsByTabId,
      tabsByWorktree,
      ptyIdsByTabId
    } = get()
    const scopedWorkspaceKeys = options ? new Set(options.workspaceKeys) : null
    const ids = (pendingReconnectWorktreeIds ?? []).filter(
      (id) => !scopedWorkspaceKeys || scopedWorkspaceKeys.has(id)
    )

    if (ids.length === 0) {
      if (options) {
        return
      }
      set({
        workspaceSessionReady: true,
        pendingReconnectWorktreeIds: [],
        pendingReconnectTabByWorktree: {},
        pendingReconnectPtyIdByTabId: {}
      })
      return
    }

    // Why: defer daemon attachment for real dimensions; eager 80×24 flushes garble output.
    let reconnectedTabsByWorktree: Record<string, TerminalTab[]> | null = null
    let reconnectedPtyIdsByTabId: Record<string, string[]> | null = null
    // Why indexed: the loop neither sets state nor awaits, so one index over the
    // whole store snapshot serves every iteration.
    const worktreeById = buildWorktreeByIdIndex(get().worktreesByRepo)
    const repoById = buildByIdIndex(get().repos)
    for (const worktreeId of ids) {
      const tabs = tabsByWorktree[worktreeId] ?? []
      const worktree = worktreeById.get(worktreeId)
      const repo = worktree ? (repoById.get(worktree.repoId) ?? null) : null
      // Why: only allow deferred reattach when the SSH connection is active; reattaching to a not-yet-connected relay (deferred/passphrase targets) would fail.
      const sshTargetId = options?.directSshAuthority.targetId ?? repo?.connectionId ?? null
      const sshState = sshTargetId ? get().sshConnectionStates.get(sshTargetId) : null
      const sshConnected = sshTargetId != null && sshState?.status === 'connected'
      const supportsDeferredReattach = options ? sshConnected : !repo?.connectionId || sshConnected
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
        const pendingPtyId = pendingReconnectPtyIdByTabId[tabId]
        const tabLevelPtyId =
          options &&
          parseAppSshPtyId(pendingPtyId ?? '')?.connectionId !== options.directSshAuthority.targetId
            ? undefined
            : pendingPtyId
        const hasLeafMappings = Object.keys(leafPtyMap).length > 0

        // Why: publish live PTY hints before mount; pty-connection reattaches later.
        console.debug(
          `[reconnect-terminals] tab=${tabId} tabLevelPtyId=${tabLevelPtyId} supportsDeferredReattach=${supportsDeferredReattach} hasLeafMappings=${hasLeafMappings}`
        )
        // Why: populate ptyIdsByTabId so the sessions status segment maps daemon IDs to tabs; otherwise all sessions look like orphans until the pane mounts.
        // A row whose tab.ptyId went to the canonical row has no tab-level id left, but its own leaf PTYs still need advertising.
        const allPtyIds = hasLeafMappings
          ? (Object.values(leafPtyMap).filter(Boolean) as string[])
          : tabLevelPtyId
            ? [tabLevelPtyId]
            : []
        if (allPtyIds.length > 0) {
          // Why: hide-sleeping reads ptyIdsByTabId for liveness; restored daemon sessions run before their pane remounts, so advertise them.
          reconnectedPtyIdsByTabId ??= { ...ptyIdsByTabId }
          reconnectedPtyIdsByTabId[tabId] = allPtyIds
        }
        if (tabLevelPtyId) {
          reconnectedTabsByWorktree ??= { ...tabsByWorktree }
          const nextTabs = reconnectedTabsByWorktree[worktreeId]
          if (!nextTabs) {
            continue
          }
          reconnectedTabsByWorktree[worktreeId] = nextTabs.map((t) =>
            t.id === tabId ? { ...t, ptyId: tabLevelPtyId } : t
          )
        }
      }
    }

    // Why: keep deferred SSH session IDs for post-cleanup reconnect.
    const scopedTabIds = new Set(
      [...(scopedWorkspaceKeys ?? ids)].flatMap((workspaceKey) =>
        (tabsByWorktree[workspaceKey] ?? []).map((tab) => tab.id)
      )
    )
    const deferredSshSessionIdsByTabId: Record<string, string> = options
      ? Object.fromEntries(
          Object.entries(get().deferredSshSessionIdsByTabId).filter(
            ([tabId]) => !scopedTabIds.has(tabId)
          )
        )
      : {}
    for (const worktreeId of ids) {
      const worktree = worktreeById.get(worktreeId)
      // Why: SSH worktrees aren't in worktreesByRepo at cold start; fall back to the repo id in the composite worktree id so sessions still reach the deferred map.
      const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
      const repo = repoId ? (repoById.get(repoId) ?? null) : null
      const connectionId = options?.directSshAuthority.targetId ?? repo?.connectionId
      if (!connectionId) {
        continue
      }
      // Why: a repo can outlive its SSH target when the target was removed out of
      // band (a crash between removal and cleanup, or edited out of the config).
      // Once the authoritative target list has loaded, don't re-defer sessions for
      // a target it no longer lists — a stranded deferred id reads as liveness and
      // the orphan sweep could never remove the dead tab. Defer while the list is
      // still unknown so a normal cold-start reconnect isn't dropped (#9911).
      if (get().sshTargetsHydrated && !get().sshTargetLabels.has(connectionId)) {
        continue
      }
      const sshConnected = get().sshConnectionStates.get(connectionId)?.status === 'connected'
      if (sshConnected) {
        continue
      }
      const tabs = tabsByWorktree[worktreeId] ?? []
      for (const tab of tabs) {
        const sessionId = pendingReconnectPtyIdByTabId[tab.id]
        if (sessionId && (!options || parseAppSshPtyId(sessionId)?.connectionId === connectionId)) {
          deferredSshSessionIdsByTabId[tab.id] = sessionId
        }
      }
    }

    if (
      signal?.aborted ||
      (options && !isCurrentDirectSshAuthority(get(), options.directSshAuthority))
    ) {
      return
    }
    const remainingReconnectWorktreeIds = options
      ? pendingReconnectWorktreeIds.filter((id) => !scopedWorkspaceKeys?.has(id))
      : []
    const remainingReconnectTabByWorktree = options
      ? Object.fromEntries(
          Object.entries(pendingReconnectTabByWorktree).filter(
            ([workspaceKey]) => !scopedWorkspaceKeys?.has(workspaceKey)
          )
        )
      : {}
    const remainingReconnectPtyIdByTabId = options
      ? Object.fromEntries(
          Object.entries(pendingReconnectPtyIdByTabId).filter(([tabId]) => !scopedTabIds.has(tabId))
        )
      : {}
    set({
      ...(reconnectedTabsByWorktree ? { tabsByWorktree: reconnectedTabsByWorktree } : {}),
      ...(reconnectedPtyIdsByTabId ? { ptyIdsByTabId: reconnectedPtyIdsByTabId } : {}),
      ...(options ? {} : { workspaceSessionReady: true }),
      pendingReconnectWorktreeIds: remainingReconnectWorktreeIds,
      pendingReconnectTabByWorktree: remainingReconnectTabByWorktree,
      pendingReconnectPtyIdByTabId: remainingReconnectPtyIdByTabId,
      deferredSshSessionIdsByTabId
    })
  }
})
