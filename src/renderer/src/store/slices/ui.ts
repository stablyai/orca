/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { normalizeRightSidebarRoute } from '../right-sidebar-route'
import {
  findPrevLiveNonTaskStackHistoryIndex,
  findPrevLiveWorktreeHistoryIndex
} from './worktree-nav-history'
import type {
  ChangelogData,
  CustomPet,
  GitHubWorkItem,
  JiraIssue,
  LinearIssue,
  ManualRepoOrderEntry,
  PersistedTrustedOrcaHooks,
  PersistedUIState,
  StatusBarItem,
  TaskProvider,
  TaskResumeState,
  TaskViewPresetId,
  TuiAgent,
  UpdateStatus,
  WorkspaceStatusDefinition,
  AgentActivityDisplayMode,
  ProjectOrderBy,
  WorktreeCardProperty,
  WorktreeCardMode,
  WorkspaceHostOrder,
  WorkspaceHostScope,
  VisibleWorkspaceHostIds,
  TopLevelView
} from '../../../../shared/types'
import {
  applyManualRepoOrder,
  normalizeManualRepoOrder
} from '../../../../shared/manual-repo-order'
import { isTopLevelView } from '../../../../shared/top-level-view'
import type { UsagePercentageDisplay } from '../../../../shared/usage-percentage-display'
import {
  DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  normalizeUsagePercentageDisplay
} from '../../../../shared/usage-percentage-display'
import {
  DEFAULT_STATUS_BAR_USAGE_MODE,
  normalizeStatusBarUsageMode,
  type StatusBarUsageMode
} from '../../../../shared/status-bar-usage-mode'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../shared/types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupDismissal
} from '../../../../shared/workspace-cleanup'
import { normalizeFeatureTipIds, type FeatureTipId } from '../../../../shared/feature-tips'
import {
  hasFeatureInteraction,
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../../shared/feature-interactions'
import {
  getContextualTour,
  normalizeContextualTourIds,
  type ContextualTourId
} from '../../../../shared/contextual-tours'
import { PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'
import {
  DEFAULT_HIDE_SLEEPING_WORKSPACES,
  DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  getWorktreeCardModeUpdates,
  normalizeAgentActivityDisplayMode,
  normalizeWorktreeCardProperties
} from '../../../../shared/constants'
import {
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  normalizeBrowserPageZoomLevel
} from '../../../../shared/browser-page-zoom'
import { persistedUIValuesEqual } from '../../../../shared/persisted-ui-equality'
import {
  normalizeExecutionHostOrder,
  normalizeExecutionHostScope,
  normalizeVisibleExecutionHostIds,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  normalizeWorkspaceStatuses
} from '../../../../shared/workspace-statuses'
import { clampMarkdownTocPanelWidth } from '../../../../shared/markdown-toc-panel-width'
import { normalizeKagiSessionLink } from '../../../../shared/browser-url'
import type { OrcaHookScriptKind } from '../../lib/orca-hook-trust'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import {
  filterSetupScriptPromptDismissalsToValidRepos,
  getSetupScriptPromptDismissalKey,
  sanitizeSetupScriptPromptDismissals
} from '../../lib/setup-script-prompt'
import { DEFAULT_PET_ID, isBundledPetId } from '../../components/pet/pet-models'
import { revokeCustomPetBlobUrl } from '../../components/pet/pet-blob-cache'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'
import {
  getContextualTourRequestDecision,
  hasContextualTourTarget,
  getNextVisibleContextualTourStepIndex,
  getPreviousVisibleContextualTourStepIndex
} from '../../components/contextual-tours/contextual-tour-gate'
import { agentKindForAgentType, formatAgentTypeLabel } from '../../lib/agent-status'
import {
  deriveRunningAgentSendTargets,
  resolveRunningAgentSendTarget
} from '../../lib/running-agent-targets'
import { buildAgentNotificationId } from '../../../../shared/agent-notification-id'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import { translate } from '@/i18n/i18n'

export type PendingSidebarWorktreeReveal = {
  worktreeId: string
  behavior: 'auto' | 'smooth'
  highlight?: boolean
  beginRename?: boolean
}

export type PendingSidebarRowReveal = {
  rowKey: string
  behavior: 'auto' | 'smooth'
  highlight?: boolean
}

export type AgentSendPopoverTargetMode = {
  id: string
  instanceId: string
  worktreeId: string
  source: 'diff-notes' | 'browser-annotations'
  prompt: string
  label: string
  launchSource: LaunchSource
  eligiblePaneKeys: string[]
  disabledPaneKeys: Record<string, string>
  status: 'open' | 'sending' | 'error'
  sendingPaneKey?: string
  error?: string
  onPromptDelivered?: () => void
}

export type OpenAgentSendPopoverTargetModeArgs = {
  id: string
  worktreeId: string
  source: AgentSendPopoverTargetMode['source']
  prompt: string
  label: string
  launchSource: LaunchSource
  onPromptDelivered?: () => void
}

function mergeFeatureInteractionState(
  current: FeatureInteractionState,
  incoming: PersistedUIState['featureInteractions']
): FeatureInteractionState {
  const currentNormalized = normalizeFeatureInteractions(current)
  const incomingNormalized = normalizeFeatureInteractions(incoming)
  const merged: FeatureInteractionState = { ...currentNormalized }
  for (const [id, incomingRecord] of Object.entries(incomingNormalized)) {
    const featureId = id as FeatureInteractionId
    const currentRecord = currentNormalized[featureId]
    merged[featureId] = currentRecord
      ? {
          firstInteractedAt: Math.min(
            currentRecord.firstInteractedAt,
            incomingRecord.firstInteractedAt
          ),
          interactionCount: Math.max(
            currentRecord.interactionCount,
            incomingRecord.interactionCount
          )
        }
      : incomingRecord
  }
  return merged
}

function mergeContextualTourSeenIds(
  current: readonly ContextualTourId[],
  incoming: PersistedUIState['contextualToursSeenIds']
): ContextualTourId[] {
  const merged = new Set<ContextualTourId>(normalizeContextualTourIds(current))
  for (const id of normalizeContextualTourIds(incoming)) {
    merged.add(id)
  }
  return [...merged]
}

function getContextualTourProgressionForFeatureInteraction(
  state: AppState,
  id: FeatureInteractionId
): 'advance' | 'complete' | 'reveal-sidebar-and-advance' | null {
  if (!state.activeContextualTourId) {
    return null
  }
  const tour = getContextualTour(state.activeContextualTourId)
  const step = tour.steps[state.activeContextualTourStepIndex]
  if (step?.advanceOnFeatureInteraction !== id) {
    return null
  }
  const nextStepIndex = getNextVisibleContextualTourStepIndex({
    tour,
    currentStepIndex: state.activeContextualTourStepIndex,
    targetExists: hasContextualTourTarget
  })
  if (nextStepIndex !== null) {
    return 'advance'
  }
  if (
    state.activeContextualTourId === 'workspace-agent-sessions' &&
    state.activeContextualTourStepIndex === 0 &&
    id === 'terminal-pane-split' &&
    !state.sidebarOpen
  ) {
    return 'reveal-sidebar-and-advance'
  }
  return 'complete'
}

function clampPetSize(size: number): number {
  if (!Number.isFinite(size)) {
    return PET_SIZE_DEFAULT
  }
  return Math.max(PET_SIZE_MIN, Math.min(PET_SIZE_MAX, Math.round(size)))
}

// Why: local copy of TaskPage's preset→query mapping avoids a store ↔ lib circular import while warming the exact cache key.
function presetToQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
    case 'all':
    case 'issues':
      return 'is:issue is:open'
    case 'my-issues':
      return 'assignee:@me is:issue is:open'
    case 'prs':
      return 'is:pr is:open'
    case 'review':
      return 'review-requested:@me is:pr is:open'
    case 'my-prs':
      return 'author:@me is:pr is:open'
    case null:
      return 'is:issue is:open'
  }
}

// Why: migrate legacy memory+sessions ids → resource-usage; keep unknown ids so downgrade→upgrade can't strip a newer build's ids.
function migrateStatusBarItems(items: readonly string[] | undefined): StatusBarItem[] {
  const source = items ?? DEFAULT_STATUS_BAR_ITEMS
  const out: string[] = []
  for (const id of source) {
    const mapped = id === 'memory' || id === 'sessions' ? 'resource-usage' : id
    if (!out.includes(mapped)) {
      out.push(mapped)
    }
  }
  return out as StatusBarItem[]
}

const DEFAULT_ON_PORTS_STATUS_BAR_ITEM: StatusBarItem = 'ports'
const DEFAULT_ON_KIMI_STATUS_BAR_ITEM: StatusBarItem = 'kimi'
const DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM: StatusBarItem = 'minimax'
const DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM: StatusBarItem = 'antigravity'
const DEFAULT_ON_GROK_STATUS_BAR_ITEM: StatusBarItem = 'grok'

function normalizeHydratedVisibleWorkspaceHostIds(ui: PersistedUIState): VisibleWorkspaceHostIds {
  const visibleHostIds = normalizeVisibleExecutionHostIds(ui.visibleWorkspaceHostIds)
  if (visibleHostIds) {
    return visibleHostIds
  }
  const legacyScope = normalizeExecutionHostScope(ui.workspaceHostScope)
  return legacyScope === 'all' ? null : [legacyScope]
}

const MIN_SIDEBAR_WIDTH = 220
const MAX_LEFT_SIDEBAR_WIDTH = 500
// Why: right-sidebar resize is window-relative, so widths can far exceed 500px on wide displays; this ceiling is only a corruption safety net.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000
const LINEAR_TASK_PREFETCH_LIMIT = 36
// Why: bound disk growth across hard quits (crash paths leave acks pinned); mirrors HYDRATE_MAX_AGE_MS in agent-hooks/server.ts.
const HYDRATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const VALID_TASK_PRESETS = new Set<TaskViewPresetId>([
  'all',
  'issues',
  'review',
  'my-issues',
  'my-prs',
  'prs'
])
const VALID_LINEAR_PRESETS = new Set<NonNullable<TaskResumeState['linearPreset']>>([
  'assigned',
  'created',
  'all',
  'completed'
])
const VALID_LINEAR_MODES = new Set<NonNullable<TaskResumeState['linearMode']>>([
  'issues',
  'projects',
  'views'
])
const VALID_JIRA_PRESETS = new Set<NonNullable<TaskResumeState['jiraPreset']>>([
  'assigned',
  'reported',
  'all',
  'done'
])

function resolvePaneKeyWorktreeIdFromTabs(state: AppState, paneKey: string): string | null {
  const parsed = parsePaneKey(paneKey)
  if (!parsed) {
    return null
  }
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === parsed.tabId)) {
      return worktreeId
    }
  }
  return null
}

function collectAcknowledgedAgentNotificationId({
  ids,
  worktreeId,
  paneKey,
  stateStartedAt,
  previousAckAt
}: {
  ids: Set<string>
  worktreeId: string | null | undefined
  paneKey: string
  stateStartedAt: number | null | undefined
  previousAckAt: number
}): void {
  if (typeof stateStartedAt !== 'number' || previousAckAt >= stateStartedAt) {
    return
  }
  const id = buildAgentNotificationId({ worktreeId, paneKey, stateStartedAt })
  if (id) {
    ids.add(id)
  }
}

function isPlainPersistedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizePersistedRepoIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return value.filter((repoId): repoId is string => typeof repoId === 'string')
}

function sanitizeTrustedOrcaHooks(trust: unknown): PersistedTrustedOrcaHooks {
  if (!isPlainPersistedRecord(trust)) {
    return {}
  }
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (!isSafePersistedRecordKey(repoId) || !isPlainPersistedRecord(entry)) {
      continue
    }
    next[repoId] = entry as PersistedTrustedOrcaHooks[string]
  }
  return next
}

function filterTrustedOrcaHooksToValidRepos(
  trust: unknown,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const sanitized = sanitizeTrustedOrcaHooks(trust)
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(sanitized)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

function hydrateTrustedOrcaHooks(
  trust: unknown,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const sanitized = sanitizeTrustedOrcaHooks(trust)
  if (validRepoIds.size === 0) {
    return sanitized
  }
  return filterTrustedOrcaHooksToValidRepos(sanitized, validRepoIds)
}

function isSafePersistedRecordKey(key: string): boolean {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

function sanitizeShowDotfilesByWorktree(value: unknown): Record<string, boolean> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, boolean> = {}
  for (const [worktreeId, showDotfiles] of Object.entries(value as Record<string, unknown>)) {
    if (!worktreeId || !isSafePersistedRecordKey(worktreeId) || typeof showDotfiles !== 'boolean') {
      continue
    }
    out[worktreeId] = showDotfiles
  }
  return out
}

function sanitizePersistedSidebarWidth(width: unknown, fallback: number, maxWidth: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
}

// Why: persisted JSON may be tampered/corrupt — reject arrays, prototype-pollution keys, and non-finite values; drop past-TTL entries.
function sanitizeAcknowledgedAgentsByPaneKey(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const cutoff = Date.now() - HYDRATE_MAX_AGE_MS
  const out: Record<string, number> = {}
  for (const [key, ackAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string' || !isSafePersistedRecordKey(key)) {
      continue
    }
    if (typeof ackAt !== 'number' || !Number.isFinite(ackAt) || ackAt <= 0) {
      continue
    }
    if (ackAt < cutoff) {
      continue
    }
    out[key] = ackAt
  }
  return out
}

function sanitizeWorkspaceCleanupDismissals(
  value: unknown
): Record<string, WorkspaceCleanupDismissal> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, WorkspaceCleanupDismissal> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue
    }
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      continue
    }
    const input = raw as Record<string, unknown>
    if (
      typeof input.worktreeId !== 'string' ||
      typeof input.dismissedAt !== 'number' ||
      !Number.isFinite(input.dismissedAt) ||
      typeof input.fingerprint !== 'string' ||
      input.classifierVersion !== WORKSPACE_CLEANUP_CLASSIFIER_VERSION
    ) {
      continue
    }
    out[key] = {
      worktreeId: input.worktreeId,
      dismissedAt: input.dismissedAt,
      fingerprint: input.fingerprint,
      classifierVersion: input.classifierVersion
    }
  }
  return out
}

function hydratedUIPartialMatchesState(state: AppState, hydrated: Partial<UISlice>): boolean {
  return Object.entries(hydrated).every(([key, value]) =>
    persistedUIValuesEqual(state[key as keyof AppState], value)
  )
}

function sanitizeHydratedActiveView(
  value: PersistedUIState['activeView'],
  experimentalActivityEnabled: boolean
): TopLevelView {
  // Why: older data (pre-activeView) or a view a different build doesn't have
  // falls back to terminal rather than rendering nothing.
  if (!isTopLevelView(value)) {
    return 'terminal'
  }
  // Why: activity is hidden when its setting is off, so gate only it (mobile/automations stay functional when hidden).
  if (value === 'activity' && !experimentalActivityEnabled) {
    return 'terminal'
  }
  return value
}

let agentSendTargetModeInstanceCounter = 0

function createAgentSendTargetModeInstanceId(): string {
  agentSendTargetModeInstanceCounter += 1
  return `${Date.now()}:${agentSendTargetModeInstanceCounter}`
}

function sanitizeTaskResumeState(value: unknown): TaskResumeState | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const input = value as Record<string, unknown>
  const next: TaskResumeState = {}

  if (input.githubMode === 'items' || input.githubMode === 'project') {
    next.githubMode = input.githubMode
  }
  if (input.githubItemsPreset === null) {
    next.githubItemsPreset = null
  } else if (typeof input.githubItemsPreset === 'string') {
    if (VALID_TASK_PRESETS.has(input.githubItemsPreset as TaskViewPresetId)) {
      next.githubItemsPreset = input.githubItemsPreset as TaskViewPresetId
    }
  }
  if (typeof input.githubItemsQuery === 'string') {
    next.githubItemsQuery = input.githubItemsQuery
  }
  if (
    typeof input.linearPreset === 'string' &&
    VALID_LINEAR_PRESETS.has(input.linearPreset as NonNullable<TaskResumeState['linearPreset']>)
  ) {
    next.linearPreset = input.linearPreset as NonNullable<TaskResumeState['linearPreset']>
  }
  if (
    typeof input.linearMode === 'string' &&
    VALID_LINEAR_MODES.has(input.linearMode as NonNullable<TaskResumeState['linearMode']>)
  ) {
    next.linearMode = input.linearMode as NonNullable<TaskResumeState['linearMode']>
  }
  if (typeof input.linearQuery === 'string') {
    next.linearQuery = input.linearQuery
  }
  if (input.linearContext && typeof input.linearContext === 'object') {
    const context = input.linearContext as Record<string, unknown>
    if (
      (context.kind === 'project' || context.kind === 'view') &&
      typeof context.id === 'string' &&
      context.id.trim() &&
      typeof context.workspaceId === 'string' &&
      context.workspaceId.trim() &&
      context.workspaceId !== 'all'
    ) {
      next.linearContext = {
        kind: context.kind,
        id: context.id,
        workspaceId: context.workspaceId,
        model: context.model === 'issue' || context.model === 'project' ? context.model : undefined
      }
    }
  }
  if (
    typeof input.jiraPreset === 'string' &&
    VALID_JIRA_PRESETS.has(input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>)
  ) {
    next.jiraPreset = input.jiraPreset as NonNullable<TaskResumeState['jiraPreset']>
  }
  if (typeof input.jiraQuery === 'string') {
    next.jiraQuery = input.jiraQuery
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export type UISlice = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  agentSendPopoverTargetMode: AgentSendPopoverTargetMode | null
  openAgentSendPopoverTargetMode: (args: OpenAgentSendPopoverTargetModeArgs) => void
  closeAgentSendPopoverTargetMode: (id?: string, instanceId?: string) => void
  sendPromptToSidebarAgentTarget: (paneKey: string) => Promise<boolean>
  /** Per-agent "I've looked at this" timestamps (paneKey → ts). A row is unvisited when no ack exists or stateStartedAt is newer than the last ack. Persisted so visited rows don't return bold on relaunch. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  activeView: TopLevelView
  previousViewBeforeTasks:
    | 'terminal'
    | 'settings'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
  previousViewBeforeSettings:
    | 'terminal'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
  previousViewBeforeActivity:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
  previousViewBeforeAutomations:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'space'
    | 'skills'
    | 'mobile'
  previousViewBeforeSpace:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'skills'
    | 'mobile'
  previousViewBeforeSkills:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'mobile'
  previousViewBeforeMobile:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
  setActiveView: (view: UISlice['activeView']) => void
  taskPageData: {
    preselectedRepoId?: string
    prefilledName?: string
    taskSource?: TaskProvider
    openGitHubWorkItem?: GitHubWorkItem
    openGitHubSourceContext?: TaskSourceContext | null
    openGitHubInitialTab?: 'conversation' | 'checks' | 'files'
    openGitLabWorkItem?: GitLabWorkItem
    openGitLabSourceContext?: TaskSourceContext | null
    openLinearIssue?: LinearIssue
    openLinearSourceContext?: TaskSourceContext | null
    openJiraIssue?: JiraIssue
    openJiraSourceContext?: TaskSourceContext | null
  }
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  githubTaskDrawerWorkItem: GitHubWorkItem | null
  setGithubTaskDrawerWorkItem: (item: GitHubWorkItem | null) => void
  newWorkspaceDraft: {
    repoId: string | null
    // Why: project-first creation uses these when present; old drafts keep using only repoId during the additive migration.
    projectId?: string | null
    projectGroupId?: string | null
    hostId?: ExecutionHostId | null
    projectHostSetupId?: string | null
    name: string
    prompt: string
    note: string
    attachments: string[]
    linkedWorkItem: {
      type: 'issue' | 'pr' | 'mr'
      number: number
      title: string
      url: string
      linearIdentifier?: string
      linearBranchName?: string
    } | null
    /** Preserve where provider data came from, separately from the host chosen to run the workspace. */
    taskSourceContext?: TaskSourceContext | null
    agent: TuiAgent
    linkedIssue: string
    linkedPR: number | null
    /** GitLab parallels — number for an issue, iid for an MR. Optional so pre-GitLab drafts still load without migration. */
    linkedGitLabIssue?: number | null
    linkedGitLabMR?: number | null
    // Why: repo-scoped start ref from the "Start from" picker; absent means "use the repo's effective base ref".
    baseBranch?: string
    // Why: review worktrees start from a head ref/SHA while Source Control compares against the provider target branch.
    compareBaseRef?: string
  } | null
  openTaskPage: (
    data?: UISlice['taskPageData'],
    options?: { recordTasksInteraction?: boolean }
  ) => void
  closeTaskPage: () => void
  openActivityPage: () => void
  closeActivityPage: () => void
  selectedAutomationId: string | null
  setSelectedAutomationId: (id: string | null) => void
  pendingAutomationRunNavigation: {
    automationId: string
    runId: string | null
    hostId?: ExecutionHostId
  } | null
  setPendingAutomationRunNavigation: (
    navigation: { automationId: string; runId: string | null; hostId?: ExecutionHostId } | null
  ) => void
  openAutomationsPage: () => void
  closeAutomationsPage: () => void
  openSpacePage: () => void
  closeSpacePage: () => void
  openSkillsPage: () => void
  closeSkillsPage: () => void
  openMobilePage: () => void
  closeMobilePage: () => void
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: {
    pane: SettingsNavTarget
    repoId: string | null
    sectionId?: string
    intent?: 'add-quick-command'
  } | null
  openSettingsTarget: (target: NonNullable<UISlice['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  /** Which host the Projects Settings pane shows per project (keyed by projectId). Ephemeral on purpose — never persisted, so reload reopens on the effective host. */
  settingsProjectHostSelection: Record<string, ExecutionHostId>
  setSettingsProjectHostSelection: (projectId: string, hostId: ExecutionHostId) => void
  /** One-shot Appearance accordion to expand for nested Settings deep links (e.g. Usage percentages under Window & Sidebar). Cleared when Appearance consumes it. */
  appearanceAccordionDeepLink: 'interface' | 'terminal' | 'window' | null
  setAppearanceAccordionDeepLink: (
    section: NonNullable<UISlice['appearanceAccordionDeepLink']>
  ) => void
  clearAppearanceAccordionDeepLink: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'forget-ssh-workspace'
    | 'confirm-add-project-from-folder'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'workspace-cleanup'
    | 'project-added'
    | 'worktree-visibility'
    | 'setup-guide'
    | 'feature-wall'
    | 'feature-tips'
    | 'new-workspace-composer'
    | 'confirm-orca-yaml-hooks'
  modalData: Record<string, unknown>
  openModal: (modal: UISlice['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  featureTipsSeenIds: FeatureTipId[]
  markFeatureTipsSeen: (ids: FeatureTipId[]) => void
  featureInteractions: FeatureInteractionState
  recordFeatureInteraction: (id: FeatureInteractionId) => Promise<void>
  contextualToursSeenIds: ContextualTourId[]
  contextualToursAutoEligible: boolean | null
  activeContextualTourId: ContextualTourId | null
  activeContextualTourStepIndex: number
  activeContextualTourSource: string | null
  activeContextualTourSourceDetached: boolean
  activeContextualTourWasFeaturePreviouslyInteracted: boolean
  contextualTourNavigationInteractionSnapshot: Partial<Record<ContextualTourId, boolean>>
  activeContextualTourSuppressed: boolean
  contextualTourShownThisSession: boolean
  contextualToursOnboardingVisible: boolean
  contextualToursBlockingSurfaceVisible: boolean
  lastCompletedContextualTourId: ContextualTourId | null
  setContextualToursAutoEligible: (eligible: boolean) => void
  setContextualToursOnboardingVisible: (visible: boolean) => void
  setContextualToursBlockingSurfaceVisible: (visible: boolean) => void
  requestContextualTour: (
    id: ContextualTourId,
    source: string,
    wasFeaturePreviouslyInteracted?: boolean,
    options?: { force?: boolean }
  ) => void
  suppressContextualTour: (id: ContextualTourId, source: string) => void
  detachContextualTourSource: (id: ContextualTourId, source: string) => void
  advanceContextualTour: () => void
  regressContextualTour: () => void
  dismissContextualTour: (id?: ContextualTourId) => void
  completeContextualTour: (id?: ContextualTourId) => void
  cancelContextualTour: (id?: ContextualTourId) => void
  markContextualToursSeen: (ids: ContextualTourId[]) => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  markOrcaHookScriptConfirmed: (
    repoId: string,
    kind: OrcaHookScriptKind,
    contentHash: string
  ) => void
  markOrcaHookRepoAlwaysTrusted: (repoId: string) => void
  clearOrcaHookTrustForRepo: (repoId: string) => void
  setupScriptPromptDismissedRepoIds: string[]
  dismissSetupScriptPrompt: (repoId: string) => void
  setupGuideSidebarDismissed: boolean
  setSetupGuideSidebarDismissed: (dismissed: boolean) => void
  setupGuideBrowserMilestoneMigrated: boolean
  setupGuideBrowserMilestoneLegacyComplete: boolean
  markSetupGuideBrowserMilestoneMigrated: (legacyComplete: boolean) => void
  browserImportHintHidden: boolean
  setBrowserImportHintHidden: (hidden: boolean) => void
  mobileEmulatorTabIntroDismissed: boolean
  dismissMobileEmulatorTabIntro: () => void
  mobileEmulatorAgentSetupDismissed: boolean
  dismissMobileEmulatorAgentSetup: () => void
  projectOrderManualDefaultNoticeDismissed: boolean
  dismissProjectOrderManualDefaultNotice: () => void
  usagePercentageDisplayChangeNoticeDismissed: boolean
  dismissUsagePercentageDisplayChangeNotice: () => void
  usageEmptyStateDismissed: boolean
  dismissUsageEmptyState: () => void
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status'
  setGroupBy: (g: UISlice['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  setSortBy: (s: UISlice['sortBy']) => void
  projectOrderBy: ProjectOrderBy
  setProjectOrderBy: (p: ProjectOrderBy) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  showSleepingWorkspaces: boolean
  setShowSleepingWorkspaces: (v: boolean) => void
  workspaceHostScope: WorkspaceHostScope
  setWorkspaceHostScope: (scope: WorkspaceHostScope) => void
  visibleWorkspaceHostIds: VisibleWorkspaceHostIds
  setVisibleWorkspaceHostIds: (ids: VisibleWorkspaceHostIds) => void
  workspaceHostOrder: WorkspaceHostOrder
  setWorkspaceHostOrder: (ids: WorkspaceHostOrder) => void
  manualRepoOrder: ManualRepoOrderEntry[]
  hideDefaultBranchWorkspace: boolean
  setHideDefaultBranchWorkspace: (v: boolean) => void
  hideAutomationGeneratedWorkspaces: boolean
  setHideAutomationGeneratedWorkspaces: (v: boolean) => void
  showDotfilesByWorktree: Record<string, boolean>
  setShowDotfilesForWorktree: (worktreeId: string, showDotfiles: boolean) => void
  toggleShowDotfilesForWorktree: (worktreeId: string) => void
  filterRepoIds: string[]
  setFilterRepoIds: (ids: string[]) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  _worktreeCardModeDefaulted: boolean
  setWorktreeCardMode: (mode: WorktreeCardMode) => void
  setWorktreeCardProperties: (properties: readonly WorktreeCardProperty[]) => void
  agentActivityDisplayMode: AgentActivityDisplayMode
  setAgentActivityDisplayMode: (mode: AgentActivityDisplayMode) => void
  workspaceStatuses: WorkspaceStatusDefinition[]
  setWorkspaceStatuses: (statuses: WorkspaceStatusDefinition[]) => void
  workspaceBoardOpacity: number
  setWorkspaceBoardOpacity: (opacity: number) => void
  workspaceBoardColumnWidth: number
  setWorkspaceBoardColumnWidth: (width: number) => void
  syncTaskStatusFromWorkspaceBoard: boolean
  setSyncTaskStatusFromWorkspaceBoard: (enabled: boolean) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  usagePercentageDisplay: UsagePercentageDisplay
  setUsagePercentageDisplay: (display: UsagePercentageDisplay) => void
  statusBarUsageMode: StatusBarUsageMode
  setStatusBarUsageMode: (mode: StatusBarUsageMode) => void
  workspacePortScan: { key: string; result: WorkspacePortScanResult } | null
  workspacePortScansByKey: Record<string, WorkspacePortScanResult>
  workspacePortScanRefreshing: boolean
  setWorkspacePortScan: (scan: { key: string; result: WorkspacePortScanResult } | null) => void
  setWorkspacePortScanProjection: (
    scan: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  replaceWorkspacePortScans: (
    scansByKey: Record<string, WorkspacePortScanResult>,
    projection: { key: string; result: WorkspacePortScanResult } | null
  ) => void
  setWorkspacePortScanForKey: (key: string, result: WorkspacePortScanResult | null) => void
  setWorkspacePortScanRefreshing: (refreshing: boolean) => void
  /** Whether the pet overlay is currently visible. Persisted so "Hide pet" survives reload. Independent of the experimentalPet flag (which gates whether it can render at all). */
  petVisible: boolean
  setPetVisible: (v: boolean) => void
  /** Which pet is active — a bundled id or a custom UUID. Persisted via PersistedUIState. */
  petId: string
  setPetId: (id: string) => void
  /** User-uploaded pet images. Metadata only — bytes live in main's userData. */
  customPets: CustomPet[]
  addCustomPet: (model: CustomPet) => void
  removeCustomPet: (id: string) => void
  /** Pet overlay size in CSS pixels (square). User-adjustable so an oversized imported sprite isn't stuck on screen. */
  petSize: number
  setPetSize: (size: number) => void
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  pendingRevealSidebarRow: PendingSidebarRowReveal | null
  revealWorktreeInSidebar: (
    worktreeId: string,
    options?: {
      behavior?: PendingSidebarWorktreeReveal['behavior']
      highlight?: boolean
      beginRename?: boolean
    }
  ) => void
  revealSidebarRow: (
    rowKey: string,
    options?: {
      behavior?: PendingSidebarRowReveal['behavior']
      highlight?: boolean
    }
  ) => void
  clearPendingRevealWorktreeId: () => void
  clearPendingRevealSidebarRow: () => void
  // Why: cleared by the diff decorator after it reveals the line, so the same id can be requested again without a stale value.
  scrollToDiffCommentId: string | null
  setScrollToDiffCommentId: (id: string | null) => void
  persistedUIReady: boolean
  uiZoomLevel: number
  setUIZoomLevel: (level: number) => void
  editorFontZoomLevel: number
  setEditorFontZoomLevel: (level: number) => void
  hydratePersistedUI: (ui: PersistedUIState, source?: 'startup' | 'sync') => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  // Why: cache last-'available' changelog so the card keeps rich content while downloading; cleared on idle/checking to avoid staleness.
  updateChangelog: ChangelogData | null
  // Why: UpdateCard is lazy-loaded and may miss the transient checking status; hold manual-check intent until a terminal state consumes it.
  updateUserInitiatedCycle: boolean
  dismissedUpdateVersion: string | null
  dismissUpdate: (versionOverride?: string) => void
  clearDismissedUpdateVersion: () => void
  // Why: ephemeral, renderer-only — never persisted; resets each session and on every phase transition (see setUpdateStatus).
  updateCardCollapsed: boolean
  setUpdateCardCollapsed: (collapsed: boolean) => void
  updateReassuranceSeen: boolean
  markUpdateReassuranceSeen: () => void
  isFullScreen: boolean
  setIsFullScreen: (v: boolean) => void
  /** URL opened when a new browser tab is created. Null = blank tab (default). */
  browserDefaultUrl: string | null
  setBrowserDefaultUrl: (url: string | null) => void
  browserDefaultSearchEngine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null
  setBrowserDefaultSearchEngine: (engine: 'google' | 'duckduckgo' | 'bing' | 'kagi' | null) => void
  browserDefaultZoomLevel: number
  setBrowserDefaultZoomLevel: (level: number) => void
  browserKagiSessionLink: string | null
  setBrowserKagiSessionLink: (link: string | null) => void
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) => ({
  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),
  agentSendPopoverTargetMode: null,
  openAgentSendPopoverTargetMode: (args) => {
    const targets = deriveRunningAgentSendTargets(get(), args.worktreeId)
    const previousMode = get().agentSendPopoverTargetMode
    if (previousMode?.id === args.id && previousMode.status === 'sending') {
      return
    }
    const disabledPaneKeys: Record<string, string> = {}
    for (const target of targets) {
      if (target.status === 'disabled' && target.disabledReason) {
        disabledPaneKeys[target.paneKey] = target.disabledReason
      }
    }
    set({
      agentSendPopoverTargetMode: {
        ...args,
        instanceId: createAgentSendTargetModeInstanceId(),
        eligiblePaneKeys: targets
          .filter((target) => target.status === 'eligible')
          .map((target) => target.paneKey),
        disabledPaneKeys,
        status: 'open'
      }
    })
    if (
      targets.some((target) => target.status === 'eligible') &&
      (previousMode?.id !== args.id || previousMode.worktreeId !== args.worktreeId)
    ) {
      get().revealWorktreeInSidebar(args.worktreeId, { behavior: 'auto', highlight: true })
    }
  },
  closeAgentSendPopoverTargetMode: (id, instanceId) =>
    set((s) => {
      if (!s.agentSendPopoverTargetMode) {
        return s
      }
      if (id && s.agentSendPopoverTargetMode.id !== id) {
        return s
      }
      if (instanceId && s.agentSendPopoverTargetMode.instanceId !== instanceId) {
        return s
      }
      return { agentSendPopoverTargetMode: null }
    }),
  sendPromptToSidebarAgentTarget: async (paneKey) => {
    const mode = get().agentSendPopoverTargetMode
    if (!mode || mode.status === 'sending') {
      return false
    }

    const target = resolveRunningAgentSendTarget(get(), mode.worktreeId, paneKey)
    if (!target || target.status !== 'eligible' || !target.ptyId) {
      // Why: eligibility can drop after the menu opened; keep the picker open (row title explains) rather than adding toast noise.
      return false
    }

    set((s) =>
      s.agentSendPopoverTargetMode?.id === mode.id &&
      s.agentSendPopoverTargetMode.instanceId === mode.instanceId
        ? {
            agentSendPopoverTargetMode: {
              ...s.agentSendPopoverTargetMode,
              status: 'sending',
              sendingPaneKey: paneKey,
              error: undefined
            }
          }
        : s
    )

    const label = formatAgentTypeLabel(target.entry.agentType)
    const { activeAgentNotesSendFailureMessage, sendNotesToActiveAgentSession } =
      await import('@/lib/active-agent-note-send')
    const result = await sendNotesToActiveAgentSession({
      worktreeId: mode.worktreeId,
      prompt: mode.prompt,
      noteTarget: { tabId: target.tabId, leafId: target.leafId }
    }).catch((error) => {
      console.error('Failed to send notes to sidebar agent target:', error)
      return { status: 'no-active-terminal' as const }
    })

    const stillCurrent = (): boolean => {
      const current = get().agentSendPopoverTargetMode
      return current?.id === mode.id && current.instanceId === mode.instanceId
    }

    if (!stillCurrent()) {
      return false
    }

    if (result.status !== 'sent') {
      const message = activeAgentNotesSendFailureMessage(result.status, { explicitTarget: true })
      set((s) =>
        s.agentSendPopoverTargetMode?.id === mode.id &&
        s.agentSendPopoverTargetMode.instanceId === mode.instanceId
          ? {
              agentSendPopoverTargetMode: {
                ...s.agentSendPopoverTargetMode,
                status: 'error',
                sendingPaneKey: undefined,
                error: message
              }
            }
          : s
      )
      const { toast } = await import('sonner')
      if (!stillCurrent()) {
        return false
      }
      toast.error(
        translate('auto.store.slices.ui.53883b7bc3', "Couldn't send to {{value0}}", {
          value0: label
        }),
        { description: message }
      )
      return false
    }

    const [{ toast }, { track }] = await Promise.all([import('sonner'), import('@/lib/telemetry')])
    if (!stillCurrent()) {
      return false
    }
    mode.onPromptDelivered?.()
    track('agent_prompt_sent', {
      agent_kind: agentKindForAgentType(target.entry.agentType),
      launch_source: mode.launchSource,
      request_kind: 'followup'
    })
    toast.success(
      translate('auto.store.slices.ui.66e3bd7ce6', 'Sent to {{value0}}', { value0: label })
    )
    get().closeAgentSendPopoverTargetMode(mode.id, mode.instanceId)
    return true
  },

  acknowledgedAgentsByPaneKey: {},
  acknowledgeAgents: (paneKeys) => {
    const notificationIdsToDismiss = new Set<string>()
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      const now = Date.now()
      // Why: only reallocate if an ack advances; compare prev<now not !== — Date.now() ticks every ms and !== would rewrite the map every call.
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
        const liveEntry = s.agentStatusByPaneKey?.[key]
        if (liveEntry) {
          collectAcknowledgedAgentNotificationId({
            ids: notificationIdsToDismiss,
            worktreeId: resolvePaneKeyWorktreeIdFromTabs(s, key) ?? liveEntry.worktreeId,
            paneKey: key,
            stateStartedAt: liveEntry.stateStartedAt,
            previousAckAt: prev
          })
        }
        const retained = s.retainedAgentsByPaneKey?.[key]
        if (retained) {
          collectAcknowledgedAgentNotificationId({
            ids: notificationIdsToDismiss,
            worktreeId: retained.worktreeId,
            paneKey: key,
            stateStartedAt: retained.entry.stateStartedAt,
            previousAckAt: prev
          })
        }
        if (prev < now) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          next[key] = now
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    })
    const notificationIds = [...notificationIdsToDismiss]
    if (notificationIds.length > 0 && typeof window !== 'undefined') {
      void window.api?.notifications?.dismiss?.(notificationIds)
    }
  },
  unacknowledgeAgents: (paneKeys) =>
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        if (s.acknowledgedAgentsByPaneKey[key] !== undefined) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          delete next[key]
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    }),

  activeView: 'terminal',
  previousViewBeforeTasks: 'terminal',
  previousViewBeforeSettings: 'terminal',
  previousViewBeforeActivity: 'terminal',
  previousViewBeforeAutomations: 'terminal',
  previousViewBeforeSpace: 'terminal',
  previousViewBeforeSkills: 'terminal',
  previousViewBeforeMobile: 'terminal',
  setActiveView: (view) => set({ activeView: view }),
  taskPageData: {},
  taskResumeState: undefined,
  githubTaskDrawerWorkItem: null,
  newWorkspaceDraft: null,
  openTaskPage: (data = {}, options = {}) => {
    if (options.recordTasksInteraction !== false) {
      const wasTasksPreviouslyInteracted = hasFeatureInteraction(get().featureInteractions, 'tasks')
      set((state) => ({
        contextualTourNavigationInteractionSnapshot: {
          ...state.contextualTourNavigationInteractionSnapshot,
          tasks: wasTasksPreviouslyInteracted
        }
      }))
      get().recordFeatureInteraction?.('tasks')
    }
    if (data.openGitHubWorkItem) {
      get().recordFeatureInteraction?.('github-tasks')
    }
    if (data.openGitLabWorkItem) {
      get().recordFeatureInteraction?.('gitlab-tasks')
    }
    if (data.openLinearIssue) {
      get().recordFeatureInteraction?.('linear-tasks')
    }
    if (data.openJiraIssue) {
      get().recordFeatureInteraction?.('jira-tasks')
    }
    // Why: record a Tasks visit in shared back/forward history; all task-source variants collapse to one deduped 'tasks' entry.
    const detailEntry = data.openGitHubWorkItem
      ? ({
          kind: 'task-detail',
          source: 'github',
          workItem: data.openGitHubWorkItem,
          sourceContext: data.openGitHubSourceContext,
          initialTab: data.openGitHubInitialTab
        } as const)
      : data.openGitLabWorkItem
        ? ({
            kind: 'task-detail',
            source: 'gitlab',
            workItem: data.openGitLabWorkItem,
            sourceContext: data.openGitLabSourceContext
          } as const)
        : data.openLinearIssue
          ? ({
              kind: 'task-detail',
              source: 'linear',
              issue: data.openLinearIssue,
              sourceContext: data.openLinearSourceContext
            } as const)
          : data.openJiraIssue
            ? ({
                kind: 'task-detail',
                source: 'jira',
                issue: data.openJiraIssue,
                sourceContext: data.openJiraSourceContext
              } as const)
            : null
    const currentEntry = get().worktreeNavHistory[get().worktreeNavHistoryIndex]
    const currentIsTaskStack =
      currentEntry === 'tasks' ||
      (typeof currentEntry === 'object' && currentEntry.kind === 'task-detail')
    if (!detailEntry || !currentIsTaskStack) {
      get().recordViewVisit('tasks')
    }
    if (detailEntry) {
      get().recordViewVisit(detailEntry)
    }
    set((state) => ({
      activeView: 'tasks',
      previousViewBeforeTasks:
        state.activeView === 'tasks' ? state.previousViewBeforeTasks : state.activeView,
      taskPageData: data
    }))
    // Why: prefetch the work-item list during first render so the page's effect hits a warm/in-flight SWR cache (~300–800ms win).
    const state = get()
    const preferredVisibleTaskProviders = normalizeVisibleTaskProviders(
      state.settings?.visibleTaskProviders
    )
    const visibleTaskProviders = restoreAvailableDefaultTaskProvider(
      preferredVisibleTaskProviders,
      {
        gitlabInstalled: state.preflightStatus?.glab?.installed === true,
        linearConnected: state.linearStatus?.connected === true
      },
      state.settings?.defaultTaskSource
    )
    const resolvedSource = resolveVisibleTaskProvider(
      data.taskSource ?? state.settings?.defaultTaskSource,
      visibleTaskProviders
    )
    const resolvedMode = state.taskResumeState?.githubMode ?? 'items'
    if (resolvedSource === 'github' && resolvedMode === 'items') {
      const eligibleRepos = state.repos.filter((repo) => isGitRepoKind(repo) && repo.path)
      const selectedRepos = (() => {
        const preferred = data.preselectedRepoId
        if (preferred) {
          const repo = eligibleRepos.find((r) => r.id === preferred)
          return repo ? [repo] : []
        }
        const persisted = state.settings?.defaultRepoSelection
        if (Array.isArray(persisted)) {
          const selected = eligibleRepos.filter((repo) => persisted.includes(repo.id))
          if (selected.length > 0) {
            return selected
          }
        }
        return eligibleRepos
      })()

      const resume = state.taskResumeState
      const defaultPreset = state.settings?.defaultTaskViewPreset ?? 'all'
      // Why: must match the query TaskPage's resume effect mounts with, else the warm cache key misses and prefetch is wasted.
      const query =
        resume?.githubItemsPreset === null
          ? (resume.githubItemsQuery ?? '').trim()
          : presetToQuery(resume?.githubItemsPreset ?? defaultPreset)
      for (const repo of selectedRepos) {
        state.prefetchWorkItems(repo.id, repo.path, PER_REPO_FETCH_LIMIT, query, {
          sourceContext:
            data.openGitHubSourceContext?.provider === 'github' &&
            data.openGitHubSourceContext.repoId === repo.id
              ? data.openGitHubSourceContext
              : null
        })
      }
    }
    if (resolvedSource === 'linear' && typeof state.prefetchLinearIssues === 'function') {
      const resume = state.taskResumeState
      const query = (resume?.linearQuery ?? '').trim()
      const sourceContext =
        data.openLinearSourceContext?.provider === 'linear' ? data.openLinearSourceContext : null
      if (query) {
        state.prefetchLinearIssues(
          { kind: 'search', query, limit: LINEAR_TASK_PREFETCH_LIMIT },
          { sourceContext }
        )
      } else {
        // Why: TaskPage no longer exposes Linear preset filters; keep prefetch aligned with the default unsearched issue list.
        state.prefetchLinearIssues(
          {
            kind: 'list',
            filter: 'all',
            limit: LINEAR_TASK_PREFETCH_LIMIT
          },
          { sourceContext }
        )
      }
    }
  },
  setTaskResumeState: (updates) =>
    set((s) => {
      const next = { ...s.taskResumeState, ...updates }
      window.api.ui.set({ taskResumeState: next }).catch(console.error)
      return { taskResumeState: next }
    }),
  setGithubTaskDrawerWorkItem: (item) => set({ githubTaskDrawerWorkItem: item }),
  closeTaskPage: () =>
    set((state) => {
      // Why: if parked on a 'tasks' entry, rewind the history index so Back/Forward aren't no-ops; keep 0 if it's the only entry.
      const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
      let nextHistoryIndex = state.worktreeNavHistoryIndex
      if (
        currentEntry === 'tasks' ||
        (typeof currentEntry === 'object' && currentEntry.kind === 'task-detail')
      ) {
        const prev = findPrevLiveNonTaskStackHistoryIndex(state)
        if (prev !== null) {
          nextHistoryIndex = prev
        } else if (typeof currentEntry === 'object' && state.worktreeNavHistory[0] === 'tasks') {
          nextHistoryIndex = 0
        }
      }
      return {
        activeView: state.previousViewBeforeTasks,
        taskPageData: {},
        githubTaskDrawerWorkItem: null,
        worktreeNavHistoryIndex: nextHistoryIndex
      }
    }),
  openActivityPage: () => {
    if (get().settings?.experimentalActivity !== true) {
      return
    }
    set((state) => ({
      activeView: 'activity',
      previousViewBeforeActivity:
        state.activeView === 'activity' ? state.previousViewBeforeActivity : state.activeView
    }))
  },
  closeActivityPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeActivity
    })),
  selectedAutomationId: null,
  setSelectedAutomationId: (id) => set({ selectedAutomationId: id }),
  pendingAutomationRunNavigation: null,
  setPendingAutomationRunNavigation: (navigation) =>
    set({ pendingAutomationRunNavigation: navigation }),
  openAutomationsPage: () => {
    get().recordViewVisit('automations')
    set((state) => ({
      activeView: 'automations',
      previousViewBeforeAutomations:
        state.activeView === 'automations' ? state.previousViewBeforeAutomations : state.activeView
    }))
  },
  closeAutomationsPage: () =>
    set((state) => {
      const currentEntry = state.worktreeNavHistory[state.worktreeNavHistoryIndex]
      let nextHistoryIndex = state.worktreeNavHistoryIndex
      if (currentEntry === 'automations') {
        const prev = findPrevLiveWorktreeHistoryIndex(state)
        if (prev !== null) {
          nextHistoryIndex = prev
        }
      }
      return {
        activeView: state.previousViewBeforeAutomations,
        worktreeNavHistoryIndex: nextHistoryIndex
      }
    }),
  openSpacePage: () => {
    get().recordFeatureInteraction?.('workspace-cleanup')
    set((state) => ({
      activeView: 'space',
      previousViewBeforeSpace:
        state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
    }))
  },
  closeSpacePage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeSpace
    })),
  openSkillsPage: () =>
    set((state) => ({
      activeView: 'skills',
      previousViewBeforeSkills:
        state.activeView === 'skills' ? state.previousViewBeforeSkills : state.activeView
    })),
  closeSkillsPage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeSkills
    })),
  openMobilePage: () =>
    set((state) => ({
      activeView: 'mobile',
      previousViewBeforeMobile:
        state.activeView === 'mobile' ? state.previousViewBeforeMobile : state.activeView
    })),
  closeMobilePage: () =>
    set((state) => ({
      activeView: state.previousViewBeforeMobile
    })),
  setNewWorkspaceDraft: (draft) => set({ newWorkspaceDraft: draft }),
  clearNewWorkspaceDraft: () => set({ newWorkspaceDraft: null }),
  openSettingsPage: () => {
    // Why: settings search is a transient filter; opening Settings shouldn't inherit hidden sections from last visit.
    get().setSettingsSearchQuery('')
    set((state) => ({
      activeView: 'settings',
      // Why: preserve the originating view so Settings back returns there (e.g. in-progress draft), not always terminal.
      previousViewBeforeSettings:
        state.activeView === 'settings' ? state.previousViewBeforeSettings : state.activeView
    }))
  },
  closeSettingsPage: () =>
    set((state) => {
      const previousView =
        state.previousViewBeforeSettings === 'activity' &&
        state.settings?.experimentalActivity !== true
          ? 'terminal'
          : state.previousViewBeforeSettings
      return { activeView: previousView }
    }),
  settingsNavigationTarget: null,
  openSettingsTarget: (target) => set({ settingsNavigationTarget: target }),
  clearSettingsTarget: () => set({ settingsNavigationTarget: null }),
  settingsProjectHostSelection: {},
  // Why: renderer-only, never persisted — no window.api.ui.set, and absent from the debounced UI writer in App.tsx.
  setSettingsProjectHostSelection: (projectId, hostId) =>
    set((s) =>
      s.settingsProjectHostSelection[projectId] === hostId
        ? s
        : {
            settingsProjectHostSelection: {
              ...s.settingsProjectHostSelection,
              [projectId]: hostId
            }
          }
    ),
  appearanceAccordionDeepLink: null,
  setAppearanceAccordionDeepLink: (section) => set({ appearanceAccordionDeepLink: section }),
  clearAppearanceAccordionDeepLink: () => set({ appearanceAccordionDeepLink: null }),

  activeModal: 'none',
  modalData: {},
  openModal: (modal, data = {}) => {
    if (modal === 'add-repo' || modal === 'create-worktree') {
      get().recordFeatureInteraction?.('workspace-creation')
    }
    set({
      activeModal: modal,
      modalData: data
    })
  },
  closeModal: () => set({ activeModal: 'none', modalData: {} }),
  featureTipsSeenIds: [],
  markFeatureTipsSeen: (ids) =>
    set((s) => {
      if (ids.length === 0) {
        return s
      }
      const current = new Set(s.featureTipsSeenIds)
      let changed = false
      for (const id of ids) {
        if (!current.has(id)) {
          current.add(id)
          changed = true
        }
      }
      if (!changed) {
        return s
      }
      const next = [...current]
      window.api.ui.set({ featureTipsSeenIds: next }).catch(console.error)
      return { featureTipsSeenIds: next }
    }),
  featureInteractions: {},
  recordFeatureInteraction: (id) => {
    let tourProgression: ReturnType<typeof getContextualTourProgressionForFeatureInteraction> = null
    let persistPromise = Promise.resolve()
    set((s) => {
      if (!s.persistedUIReady) {
        return s
      }
      tourProgression = getContextualTourProgressionForFeatureInteraction(s, id)
      const existing = s.featureInteractions[id]
      const next: FeatureInteractionState = {
        ...s.featureInteractions,
        [id]: {
          firstInteractedAt: existing?.firstInteractedAt ?? Date.now(),
          interactionCount: (existing?.interactionCount ?? 0) + 1
        }
      }
      if (typeof window !== 'undefined') {
        const recordInteraction = window.api.ui.recordFeatureInteraction
        const persist = recordInteraction
          ? recordInteraction(id).then((ui) => {
              set((current) => ({
                featureInteractions: mergeFeatureInteractionState(
                  current.featureInteractions,
                  ui.featureInteractions
                ),
                contextualToursSeenIds: mergeContextualTourSeenIds(
                  current.contextualToursSeenIds,
                  ui.contextualToursSeenIds
                )
              }))
            })
          : window.api.ui.set({ featureInteractions: next })
        persistPromise = persist.catch(console.error)
      }
      if (tourProgression === 'reveal-sidebar-and-advance') {
        // Why: split can fire from keyboard/menu with the sidebar closed, but the next tour target lives in the sidebar.
        return {
          featureInteractions: next,
          sidebarOpen: true,
          activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1
        }
      }
      return { featureInteractions: next }
    })
    if (tourProgression === 'complete') {
      get().completeContextualTour()
    } else if (tourProgression === 'advance') {
      get().advanceContextualTour()
    }
    return persistPromise
  },
  contextualToursSeenIds: [],
  contextualToursAutoEligible: null,
  activeContextualTourId: null,
  activeContextualTourStepIndex: 0,
  activeContextualTourSource: null,
  activeContextualTourSourceDetached: false,
  activeContextualTourWasFeaturePreviouslyInteracted: false,
  contextualTourNavigationInteractionSnapshot: {},
  activeContextualTourSuppressed: false,
  contextualTourShownThisSession: false,
  contextualToursOnboardingVisible: false,
  contextualToursBlockingSurfaceVisible: false,
  lastCompletedContextualTourId: null,
  setContextualToursAutoEligible: (eligible) =>
    set((s) => {
      if (s.contextualToursAutoEligible === eligible) {
        return s
      }
      if (typeof window !== 'undefined') {
        window.api.ui.set({ contextualToursAutoEligible: eligible }).catch(console.error)
      }
      return { contextualToursAutoEligible: eligible }
    }),
  setContextualToursOnboardingVisible: (visible) =>
    set((s) =>
      s.contextualToursOnboardingVisible === visible
        ? s
        : { contextualToursOnboardingVisible: visible }
    ),
  setContextualToursBlockingSurfaceVisible: (visible) =>
    set((s) =>
      s.contextualToursBlockingSurfaceVisible === visible
        ? s
        : { contextualToursBlockingSurfaceVisible: visible }
    ),
  requestContextualTour: (id, source, wasFeaturePreviouslyInteracted, options) =>
    set((s) => {
      const tour = getContextualTour(id)
      const decision = getContextualTourRequestDecision({
        tour,
        persistedUIReady: s.persistedUIReady,
        autoEligible: options?.force === true || s.contextualToursAutoEligible === true,
        onboardingVisible: s.contextualToursOnboardingVisible,
        seenIds: options?.force === true ? [] : s.contextualToursSeenIds,
        sessionConsumed: options?.force === true ? false : s.contextualTourShownThisSession,
        activeTourId: s.activeContextualTourId,
        activeModal: s.activeModal,
        blockingSurfaceVisible: s.contextualToursBlockingSurfaceVisible,
        targetExists: hasContextualTourTarget
      })
      if (decision.kind !== 'start') {
        if (s.contextualTourNavigationInteractionSnapshot[id] === undefined) {
          return s
        }
        const { [id]: _consumed, ...remainingNavigationSnapshot } =
          s.contextualTourNavigationInteractionSnapshot
        void _consumed
        return { contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot }
      }
      const navigationSnapshot = s.contextualTourNavigationInteractionSnapshot[id]
      const { [id]: _consumed, ...remainingNavigationSnapshot } =
        s.contextualTourNavigationInteractionSnapshot
      void _consumed
      return {
        activeContextualTourId: id,
        activeContextualTourStepIndex: decision.stepIndex,
        activeContextualTourSource: source,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted:
          wasFeaturePreviouslyInteracted ??
          navigationSnapshot ??
          hasFeatureInteraction(s.featureInteractions, id),
        contextualTourNavigationInteractionSnapshot: remainingNavigationSnapshot,
        activeContextualTourSuppressed: false,
        contextualTourShownThisSession: true,
        lastCompletedContextualTourId: null
      }
    }),
  suppressContextualTour: (id, source) =>
    set((s) => {
      if (
        s.activeContextualTourId !== id ||
        s.activeContextualTourSource !== source ||
        s.activeContextualTourSourceDetached
      ) {
        return s
      }
      return s.activeContextualTourSuppressed ? s : { activeContextualTourSuppressed: true }
    }),
  detachContextualTourSource: (id, source) =>
    set((s) => {
      if (s.activeContextualTourId !== id || s.activeContextualTourSource !== source) {
        return s
      }
      return s.activeContextualTourSourceDetached ? s : { activeContextualTourSourceDetached: true }
    }),
  advanceContextualTour: () =>
    set((s) => {
      if (!s.activeContextualTourId) {
        return s
      }
      const tour = getContextualTour(s.activeContextualTourId)
      const nextStepIndex = getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: s.activeContextualTourStepIndex,
        targetExists: hasContextualTourTarget
      })
      if (nextStepIndex !== null) {
        return { activeContextualTourStepIndex: nextStepIndex }
      }
      // Why: browser step 3's target lives in a closed menu until that step is active.
      if (
        s.activeContextualTourId === 'browser' &&
        s.activeContextualTourStepIndex + 1 < tour.steps.length
      ) {
        return { activeContextualTourStepIndex: s.activeContextualTourStepIndex + 1 }
      }
      return s
    }),
  regressContextualTour: () =>
    set((s) => {
      if (!s.activeContextualTourId) {
        return s
      }
      const previousStepIndex = getPreviousVisibleContextualTourStepIndex({
        tour: getContextualTour(s.activeContextualTourId),
        currentStepIndex: s.activeContextualTourStepIndex,
        targetExists: hasContextualTourTarget
      })
      if (previousStepIndex === null) {
        return s
      }
      return { activeContextualTourStepIndex: previousStepIndex }
    }),
  dismissContextualTour: (id) => {
    const activeTourId = get().activeContextualTourId
    if (id && activeTourId !== id) {
      return
    }
    const tourId = id ?? activeTourId
    if (tourId) {
      get().markContextualToursSeen([tourId])
    }
    set((s) => {
      if (id && s.activeContextualTourId !== id) {
        return s
      }
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: null
      }
    })
  },
  completeContextualTour: (id) => {
    const activeTourId = get().activeContextualTourId
    if (id && activeTourId !== id) {
      return
    }
    const tourId = id ?? activeTourId
    if (tourId) {
      get().markContextualToursSeen([tourId])
    }
    set((s) => {
      if (id && s.activeContextualTourId !== id) {
        return s
      }
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: tourId ?? null
      }
    })
  },
  cancelContextualTour: (id) =>
    set((s) => {
      const activeTourId = s.activeContextualTourId
      const tourId = id ?? activeTourId
      if (!tourId || (id && activeTourId !== id)) {
        return s
      }
      const alreadyShown = s.contextualToursSeenIds.includes(tourId)
      return {
        activeContextualTourId: null,
        activeContextualTourStepIndex: 0,
        activeContextualTourSource: null,
        activeContextualTourSourceDetached: false,
        activeContextualTourWasFeaturePreviouslyInteracted: false,
        activeContextualTourSuppressed: false,
        lastCompletedContextualTourId: null,
        contextualTourShownThisSession: alreadyShown ? s.contextualTourShownThisSession : false
      }
    }),
  markContextualToursSeen: (ids) =>
    set((s) => {
      if (ids.length === 0) {
        return s
      }
      const current = new Set(s.contextualToursSeenIds)
      let changed = false
      for (const id of ids) {
        if (!current.has(id)) {
          current.add(id)
          changed = true
        }
      }
      if (!changed) {
        return s
      }
      const next = [...current]
      if (typeof window !== 'undefined') {
        window.api.ui.set({ contextualToursSeenIds: next }).catch(console.error)
      }
      return { contextualToursSeenIds: next }
    }),
  trustedOrcaHooks: {},
  markOrcaHookScriptConfirmed: (repoId, kind, contentHash) =>
    set((s) => {
      const existing = s.trustedOrcaHooks[repoId]
      const currentEntry = existing?.[kind]
      if (currentEntry?.contentHash === contentHash) {
        return s
      }
      const nextRepo = {
        ...existing,
        [kind]: { contentHash, approvedAt: Date.now() }
      }
      const next = { ...s.trustedOrcaHooks, [repoId]: nextRepo }
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  markOrcaHookRepoAlwaysTrusted: (repoId) =>
    set((s) => {
      const existing = s.trustedOrcaHooks[repoId]
      if (existing?.all) {
        return s
      }
      const next = {
        ...s.trustedOrcaHooks,
        [repoId]: {
          ...existing,
          all: { approvedAt: Date.now() }
        }
      }
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  clearOrcaHookTrustForRepo: (repoId) =>
    set((s) => {
      if (!(repoId in s.trustedOrcaHooks)) {
        return s
      }
      const next = { ...s.trustedOrcaHooks }
      delete next[repoId]
      window.api.ui.set({ trustedOrcaHooks: next }).catch(console.error)
      return { trustedOrcaHooks: next }
    }),
  setupScriptPromptDismissedRepoIds: [],
  dismissSetupScriptPrompt: (repoId) =>
    set((s) => {
      const dismissalKey = getSetupScriptPromptDismissalKey(repoId)
      if (!repoId || s.setupScriptPromptDismissedRepoIds.includes(dismissalKey)) {
        return s
      }
      const next = [...s.setupScriptPromptDismissedRepoIds, dismissalKey]
      window.api.ui.set({ setupScriptPromptDismissedRepoIds: next }).catch(console.error)
      return { setupScriptPromptDismissedRepoIds: next }
    }),
  setupGuideSidebarDismissed: false,
  setSetupGuideSidebarDismissed: (dismissed) =>
    set((s) => {
      if (s.setupGuideSidebarDismissed === dismissed) {
        return s
      }
      window.api.ui.set({ setupGuideSidebarDismissed: dismissed }).catch(console.error)
      return { setupGuideSidebarDismissed: dismissed }
    }),
  setupGuideBrowserMilestoneMigrated: true,
  setupGuideBrowserMilestoneLegacyComplete: false,
  markSetupGuideBrowserMilestoneMigrated: (legacyComplete) =>
    set((s) => {
      if (
        s.setupGuideBrowserMilestoneMigrated &&
        s.setupGuideBrowserMilestoneLegacyComplete === legacyComplete
      ) {
        return s
      }
      const updates = {
        setupGuideBrowserMilestoneMigrated: true,
        setupGuideBrowserMilestoneLegacyComplete: legacyComplete
      }
      window.api.ui.set(updates).catch(console.error)
      return updates
    }),
  browserImportHintHidden: false,
  setBrowserImportHintHidden: (hidden) =>
    set((s) => {
      if (s.browserImportHintHidden === hidden) {
        return s
      }
      window.api.ui.set({ browserImportHintHidden: hidden }).catch(console.error)
      return { browserImportHintHidden: hidden }
    }),
  mobileEmulatorTabIntroDismissed: false,
  dismissMobileEmulatorTabIntro: () =>
    set((s) => {
      if (s.mobileEmulatorTabIntroDismissed) {
        return s
      }
      window.api.ui.set({ mobileEmulatorTabIntroDismissed: true }).catch(console.error)
      return { mobileEmulatorTabIntroDismissed: true }
    }),
  mobileEmulatorAgentSetupDismissed: false,
  dismissMobileEmulatorAgentSetup: () =>
    set((s) => {
      if (s.mobileEmulatorAgentSetupDismissed) {
        return s
      }
      window.api.ui.set({ mobileEmulatorAgentSetupDismissed: true }).catch(console.error)
      return { mobileEmulatorAgentSetupDismissed: true }
    }),
  projectOrderManualDefaultNoticeDismissed: true,
  dismissProjectOrderManualDefaultNotice: () =>
    set((s) => {
      if (s.projectOrderManualDefaultNoticeDismissed) {
        return s
      }
      window.api.ui.set({ projectOrderManualDefaultNoticeDismissed: true }).catch(console.error)
      return { projectOrderManualDefaultNoticeDismissed: true }
    }),
  // Why: default true so pre-hydration / new sessions never flash the change notice before persistence resolves.
  usagePercentageDisplayChangeNoticeDismissed: true,
  dismissUsagePercentageDisplayChangeNotice: () =>
    set((s) => {
      if (s.usagePercentageDisplayChangeNoticeDismissed) {
        return s
      }
      window.api.ui.set({ usagePercentageDisplayChangeNoticeDismissed: true }).catch(console.error)
      return { usagePercentageDisplayChangeNoticeDismissed: true }
    }),
  usageEmptyStateDismissed: false,
  dismissUsageEmptyState: () =>
    set((s) => {
      if (s.usageEmptyStateDismissed) {
        return s
      }
      window.api.ui.set({ usageEmptyStateDismissed: true }).catch(console.error)
      return { usageEmptyStateDismissed: true }
    }),

  groupBy: 'repo',
  // Why: group keys are mode-specific, so clear collapsed state on mode switch — stale keys are meaningless and accumulate.
  setGroupBy: (g) => {
    window.api.ui.set({ groupBy: g, collapsedGroups: [] }).catch(console.error)
    set({ groupBy: g, collapsedGroups: new Set<string>() })
  },

  sortBy: 'recent',
  setSortBy: (s) => set({ sortBy: s }),

  // Why: bare set — persists only via the debounced window.api.ui.set writer in App.tsx, not on its own.
  projectOrderBy: 'manual',
  setProjectOrderBy: (p) => set({ projectOrderBy: p }),

  showActiveOnly: false,
  setShowActiveOnly: (v) => set({ showActiveOnly: v }),

  showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
  setShowSleepingWorkspaces: (v) => set({ showSleepingWorkspaces: v }),

  workspaceHostScope: 'all',
  // Why: host scope is presentation/filtering only — must never trigger resource teardown (terminals, browser pages).
  setWorkspaceHostScope: (scope) => {
    const normalized = normalizeExecutionHostScope(scope)
    const visibleWorkspaceHostIds = normalized === 'all' ? null : [normalized]
    set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
    window.api.ui
      .set({ workspaceHostScope: normalized, visibleWorkspaceHostIds })
      .catch(console.error)
  },
  visibleWorkspaceHostIds: null,
  setVisibleWorkspaceHostIds: (ids) => {
    const normalized = normalizeVisibleExecutionHostIds(ids)
    // Why: workspaceHostScope stays the compat/default-host signal for creation flows; visibility can now be multi-select.
    let workspaceHostScope: WorkspaceHostScope = get().workspaceHostScope
    if (normalized === null) {
      workspaceHostScope = 'all'
    } else if (normalized.length === 1) {
      workspaceHostScope = normalized[0]
    }
    set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
    window.api.ui
      .set({ visibleWorkspaceHostIds: normalized, workspaceHostScope })
      .catch(console.error)
  },
  workspaceHostOrder: [],
  setWorkspaceHostOrder: (ids) => {
    const workspaceHostOrder = normalizeExecutionHostOrder(ids)
    set({ workspaceHostOrder })
    window.api.ui.set({ workspaceHostOrder }).catch(console.error)
  },
  manualRepoOrder: [],

  hideDefaultBranchWorkspace: false,
  setHideDefaultBranchWorkspace: (v) => set({ hideDefaultBranchWorkspace: v }),
  hideAutomationGeneratedWorkspaces: false,
  setHideAutomationGeneratedWorkspaces: (v) => set({ hideAutomationGeneratedWorkspaces: v }),

  showDotfilesByWorktree: {},
  setShowDotfilesForWorktree: (worktreeId, showDotfiles) =>
    set((s) => {
      if (!worktreeId) {
        return s
      }
      const current = s.showDotfilesByWorktree[worktreeId] ?? true
      if (current === showDotfiles) {
        return s
      }
      const next = { ...s.showDotfilesByWorktree }
      // Why: showing dotfiles is the default; only persist worktree-level opt-outs.
      if (showDotfiles) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = false
      }
      return { showDotfilesByWorktree: next }
    }),
  toggleShowDotfilesForWorktree: (worktreeId) =>
    set((s) => {
      if (!worktreeId) {
        return s
      }
      const nextShowDotfiles = !(s.showDotfilesByWorktree[worktreeId] ?? true)
      const next = { ...s.showDotfilesByWorktree }
      if (nextShowDotfiles) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = false
      }
      return { showDotfilesByWorktree: next }
    }),

  filterRepoIds: [],
  setFilterRepoIds: (ids) => set({ filterRepoIds: ids }),

  collapsedGroups: new Set<string>(),
  toggleCollapsedGroup: (key) =>
    set((s) => {
      const next = new Set(s.collapsedGroups)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      window.api.ui.set({ collapsedGroups: [...next] }).catch(console.error)
      return { collapsedGroups: next }
    }),

  worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
  _worktreeCardModeDefaulted: true,
  setWorktreeCardMode: (mode) => {
    const updates = getWorktreeCardModeUpdates(mode)
    set((s) => ({
      settings: s.settings ? { ...s.settings, ...updates.settings } : s.settings,
      worktreeCardProperties: updates.ui.worktreeCardProperties,
      _worktreeCardModeDefaulted: true
    }))
    void Promise.all([
      window.api.settings.set(updates.settings).then((nextSettings) => {
        if (nextSettings) {
          set({ settings: nextSettings })
        }
      }),
      window.api.ui.set(updates.ui)
    ]).catch(console.error)
  },
  setWorktreeCardProperties: (properties) => {
    const normalized = normalizeWorktreeCardProperties(properties)
    set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
    window.api.ui
      .set({ worktreeCardProperties: normalized, _worktreeCardModeDefaulted: false })
      .catch(console.error)
  },
  agentActivityDisplayMode: DEFAULT_AGENT_ACTIVITY_DISPLAY_MODE,
  setAgentActivityDisplayMode: (mode) => {
    const normalized = normalizeAgentActivityDisplayMode(mode)
    window.api.ui.set({ agentActivityDisplayMode: normalized }).catch(console.error)
    set({ agentActivityDisplayMode: normalized })
  },

  workspaceStatuses: cloneDefaultWorkspaceStatuses(),
  setWorkspaceStatuses: (statuses) => {
    const normalized = normalizeWorkspaceStatuses(statuses)
    window.api.ui.set({ workspaceStatuses: normalized }).catch(console.error)
    set({ workspaceStatuses: normalized })
  },

  workspaceBoardOpacity: 1,
  setWorkspaceBoardOpacity: (opacity) => {
    const clamped = clampWorkspaceBoardOpacity(opacity)
    window.api.ui.set({ workspaceBoardOpacity: clamped }).catch(console.error)
    set({ workspaceBoardOpacity: clamped })
  },

  workspaceBoardColumnWidth: WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  setWorkspaceBoardColumnWidth: (width) => {
    const clamped = clampWorkspaceBoardColumnWidth(width)
    window.api.ui.set({ workspaceBoardColumnWidth: clamped }).catch(console.error)
    set({ workspaceBoardColumnWidth: clamped })
  },

  syncTaskStatusFromWorkspaceBoard: false,
  setSyncTaskStatusFromWorkspaceBoard: (enabled) => {
    window.api.ui.set({ syncTaskStatusFromWorkspaceBoard: enabled }).catch(console.error)
    set({ syncTaskStatusFromWorkspaceBoard: enabled })
  },

  statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
  toggleStatusBarItem: (item) =>
    set((s) => {
      const current = s.statusBarItems || DEFAULT_STATUS_BAR_ITEMS
      const updated = current.includes(item)
        ? current.filter((i) => i !== item)
        : [...current, item]
      window.api.ui.set({ statusBarItems: updated }).catch(console.error)
      return { statusBarItems: updated }
    }),

  statusBarVisible: true,
  setStatusBarVisible: (v) => {
    window.api.ui.set({ statusBarVisible: v }).catch(console.error)
    set({ statusBarVisible: v })
  },
  usagePercentageDisplay: DEFAULT_USAGE_PERCENTAGE_DISPLAY,
  setUsagePercentageDisplay: (display) => {
    const normalized = normalizeUsagePercentageDisplay(display)
    // Why: changing the control is the discovery path, so permanently dismiss the one-time change notice.
    window.api.ui
      .set({
        usagePercentageDisplay: normalized,
        usagePercentageDisplayChangeNoticeDismissed: true
      })
      .catch(console.error)
    set({
      usagePercentageDisplay: normalized,
      usagePercentageDisplayChangeNoticeDismissed: true
    })
  },
  statusBarUsageMode: DEFAULT_STATUS_BAR_USAGE_MODE,
  setStatusBarUsageMode: (mode) => {
    const normalized = normalizeStatusBarUsageMode(mode)
    window.api.ui.set({ statusBarUsageMode: normalized }).catch(console.error)
    set({ statusBarUsageMode: normalized })
  },
  workspacePortScan: null,
  workspacePortScansByKey: {},
  workspacePortScanRefreshing: false,
  setWorkspacePortScan: (scan) =>
    set((state) => {
      if (!scan) {
        if (!state.workspacePortScan && Object.keys(state.workspacePortScansByKey).length === 0) {
          return state
        }
        return { workspacePortScan: null, workspacePortScansByKey: {} }
      }
      if (
        state.workspacePortScan?.key === scan.key &&
        state.workspacePortScan.result === scan.result &&
        state.workspacePortScansByKey[scan.key] === scan.result
      ) {
        return state
      }
      return {
        workspacePortScan: scan,
        workspacePortScansByKey: { ...state.workspacePortScansByKey, [scan.key]: scan.result }
      }
    }),
  // Why: target changes rebuild the aggregate without republishing or clearing per-host scans.
  setWorkspacePortScanProjection: (scan) =>
    set((state) => {
      if (
        state.workspacePortScan?.key === scan?.key &&
        state.workspacePortScan?.result === scan?.result
      ) {
        return state
      }
      return { workspacePortScan: scan }
    }),
  // Why: drop stale per-host scans in one store update so a large host set can't fan out notifications to every subscriber.
  replaceWorkspacePortScans: (scansByKey, projection) =>
    set((state) => {
      if (
        state.workspacePortScansByKey === scansByKey &&
        state.workspacePortScan?.key === projection?.key &&
        state.workspacePortScan?.result === projection?.result
      ) {
        return state
      }
      return { workspacePortScansByKey: scansByKey, workspacePortScan: projection }
    }),
  setWorkspacePortScanForKey: (key, result) =>
    set((state) => {
      const currentResult = state.workspacePortScansByKey[key]
      if (currentResult === result || (!result && !currentResult)) {
        return state
      }
      const nextScansByKey = { ...state.workspacePortScansByKey }
      if (result) {
        nextScansByKey[key] = result
      } else {
        delete nextScansByKey[key]
      }
      return {
        workspacePortScansByKey: nextScansByKey,
        workspacePortScan:
          state.workspacePortScan?.key === key
            ? result
              ? { key, result }
              : null
            : state.workspacePortScan
      }
    }),
  setWorkspacePortScanRefreshing: (refreshing) => set({ workspacePortScanRefreshing: refreshing }),

  // Why: default true so enabling experimentalPet shows the pet immediately (persisted; "Hide pet" flips it false).
  petVisible: true,
  setPetVisible: (v) => {
    window.api.ui.set({ petVisible: v }).catch(console.error)
    set({ petVisible: v })
  },

  petId: DEFAULT_PET_ID,
  setPetId: (id) => {
    window.api.ui.set({ petId: id }).catch(console.error)
    set({ petId: id })
  },

  petSize: PET_SIZE_DEFAULT,
  setPetSize: (size) => {
    const clamped = clampPetSize(size)
    window.api.ui.set({ petSize: clamped }).catch(console.error)
    set({ petSize: clamped })
  },

  customPets: [],
  addCustomPet: (model) =>
    set((s) => {
      const next = [...s.customPets.filter((m) => m.id !== model.id), model]
      window.api.ui.set({ customPets: next }).catch(console.error)
      return { customPets: next }
    }),
  removeCustomPet: (id) =>
    set((s) => {
      const target = s.customPets.find((m) => m.id === id)
      if (!target) {
        return s
      }
      const next = s.customPets.filter((m) => m.id !== id)
      // Why: removing the active custom pet falls back to bundled default so the overlay isn't empty.
      const fallback = s.petId === id ? DEFAULT_PET_ID : s.petId
      // Why: single combined IPC update so customPets and petId persist atomically.
      const ipcPayload: { customPets: CustomPet[]; petId?: string } = {
        customPets: next
      }
      if (fallback !== s.petId) {
        ipcPayload.petId = fallback
      }
      window.api.ui.set(ipcPayload).catch(console.error)
      // Why: revoke the cached blob: URL so the Blob is released, not leaked for the session.
      revokeCustomPetBlobUrl(id)
      // Why: best-effort delete — bytes owned by main; fresh-UUID imports mean an orphaned file is never re-referenced.
      window.api.pet.delete(id, target.fileName, target.kind).catch(console.error)
      const partial: Partial<UISlice> = { customPets: next }
      if (fallback !== s.petId) {
        partial.petId = fallback
      }
      return partial
    }),

  pendingRevealWorktree: null,
  pendingRevealSidebarRow: null,
  revealWorktreeInSidebar: (worktreeId, options) =>
    set({
      pendingRevealWorktree: {
        worktreeId,
        behavior: options?.behavior ?? 'smooth',
        ...(options?.highlight ? { highlight: true } : {}),
        ...(options?.beginRename ? { beginRename: true } : {})
      }
    }),
  revealSidebarRow: (rowKey, options) =>
    set({
      pendingRevealSidebarRow: {
        rowKey,
        behavior: options?.behavior ?? 'smooth',
        ...(options?.highlight === false ? {} : { highlight: true })
      }
    }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktree: null }),
  clearPendingRevealSidebarRow: () => set({ pendingRevealSidebarRow: null }),
  scrollToDiffCommentId: null,
  setScrollToDiffCommentId: (id) => set({ scrollToDiffCommentId: id }),
  persistedUIReady: false,
  uiZoomLevel: 0,
  setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
  editorFontZoomLevel: 0,
  setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),

  hydratePersistedUI: (ui, source = 'sync') =>
    set((s) => {
      const manualRepoOrder = normalizeManualRepoOrder(ui.manualRepoOrder)
      const orderedRepos = applyManualRepoOrder(s.repos, manualRepoOrder)
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
      const persistedFilterRepoIds = sanitizePersistedRepoIds(ui.filterRepoIds)
      // Why: pre-rename builds used sidekick* keys; read as fallback only so new pet* writes win after upgrade.
      const customPets = Array.isArray(ui.customPets)
        ? ui.customPets
        : Array.isArray(ui.customSidekicks)
          ? ui.customSidekicks
          : []
      const petId = ui.petId ?? ui.sidekickId
      // Migration: one-shot old-'recent'→'smart' runs in main (_sortBySmartMigrated), not here, so a deliberate 'recent' choice survives restart.
      const sortBy = ui.sortBy
      const migratedStatusBarItems = migrateStatusBarItems(ui.statusBarItems)
      const statusBarItemsWithPorts =
        ui._portsStatusBarDefaultAdded || migratedStatusBarItems.includes('ports')
          ? migratedStatusBarItems
          : [...migratedStatusBarItems, DEFAULT_ON_PORTS_STATUS_BAR_ITEM]
      const statusBarItems =
        ui._kimiStatusBarDefaultAdded || statusBarItemsWithPorts.includes('kimi')
          ? statusBarItemsWithPorts
          : [...statusBarItemsWithPorts, DEFAULT_ON_KIMI_STATUS_BAR_ITEM]
      const statusBarItemsWithMiniMax =
        ui._minimaxStatusBarDefaultAdded || statusBarItems.includes('minimax')
          ? statusBarItems
          : [...statusBarItems, DEFAULT_ON_MINIMAX_STATUS_BAR_ITEM]
      const statusBarItemsWithAntigravity =
        ui._antigravityStatusBarDefaultAdded || statusBarItemsWithMiniMax.includes('antigravity')
          ? statusBarItemsWithMiniMax
          : [...statusBarItemsWithMiniMax, DEFAULT_ON_ANTIGRAVITY_STATUS_BAR_ITEM]
      const statusBarItemsWithGrok =
        ui._grokStatusBarDefaultAdded || statusBarItemsWithAntigravity.includes('grok')
          ? statusBarItemsWithAntigravity
          : [...statusBarItemsWithAntigravity, DEFAULT_ON_GROK_STATUS_BAR_ITEM]
      if (
        (!ui._portsStatusBarDefaultAdded ||
          !ui._kimiStatusBarDefaultAdded ||
          !ui._minimaxStatusBarDefaultAdded ||
          !ui._antigravityStatusBarDefaultAdded ||
          !ui._grokStatusBarDefaultAdded) &&
        typeof window !== 'undefined'
      ) {
        window.api.ui
          .set({
            statusBarItems: statusBarItemsWithGrok,
            _portsStatusBarDefaultAdded: true,
            _kimiStatusBarDefaultAdded: true,
            _minimaxStatusBarDefaultAdded: true,
            _antigravityStatusBarDefaultAdded: true,
            _grokStatusBarDefaultAdded: true
          })
          .catch(console.error)
      }
      const rightSidebarRoute = normalizeRightSidebarRoute(
        ui.rightSidebarTab,
        ui.rightSidebarExplorerView
      )
      const hydrated = {
        // Why: persisted widths may be stale/corrupt/hand-edited; clamp during hydration so invalid values can't break layout.
        sidebarWidth: sanitizePersistedSidebarWidth(
          ui.sidebarWidth,
          s.sidebarWidth,
          MAX_LEFT_SIDEBAR_WIDTH
        ),
        rightSidebarWidth: sanitizePersistedSidebarWidth(
          ui.rightSidebarWidth,
          s.rightSidebarWidth,
          MAX_RIGHT_SIDEBAR_WIDTH
        ),
        markdownTocPanelWidth: clampMarkdownTocPanelWidth(
          ui.markdownTocPanelWidth,
          undefined,
          s.markdownTocPanelWidth
        ),
        rightSidebarOpen: typeof ui.rightSidebarOpen === 'boolean' ? ui.rightSidebarOpen : true,
        rightSidebarTab: rightSidebarRoute.rightSidebarTab,
        rightSidebarExplorerView: rightSidebarRoute.rightSidebarExplorerView,
        groupBy: (ui.groupBy as UISlice['groupBy'] | 'parent') === 'parent' ? 'repo' : ui.groupBy,
        sortBy,
        // Why: main-process getUI() already normalized this (defaulting to 'manual'); read it through without migrating.
        projectOrderBy: ui.projectOrderBy,
        // Why: Active-only was retired; force the old flag off so an old profile can't invisibly narrow the workspace list.
        showActiveOnly: false,
        // Why: ignore older positive-form keys so old profiles start from the new default (sleeping workspaces visible).
        showSleepingWorkspaces: !(ui.hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
        workspaceHostScope: normalizeExecutionHostScope(ui.workspaceHostScope),
        visibleWorkspaceHostIds: normalizeHydratedVisibleWorkspaceHostIds(ui),
        workspaceHostOrder: normalizeExecutionHostOrder(ui.workspaceHostOrder),
        manualRepoOrder,
        // Why: apply the desktop-owned overlay immediately since UI state can arrive after a catalog or from another client.
        repos: orderedRepos,
        hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
        hideAutomationGeneratedWorkspaces: ui.hideAutomationGeneratedWorkspaces === true,
        showDotfilesByWorktree: sanitizeShowDotfilesByWorktree(ui.showDotfilesByWorktree),
        // Why: startup hydrates UI before repo catalogs, so defer repo-filter validation to the all-host refresh.
        filterRepoIds:
          validRepoIds.size === 0
            ? persistedFilterRepoIds
            : persistedFilterRepoIds.filter((repoId) => validRepoIds.has(repoId)),
        collapsedGroups: new Set(ui.collapsedGroups ?? []),
        uiZoomLevel: ui.uiZoomLevel ?? 0,
        editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
        worktreeCardProperties: normalizeWorktreeCardProperties(ui.worktreeCardProperties),
        _worktreeCardModeDefaulted: ui._worktreeCardModeDefaulted === true,
        agentActivityDisplayMode: normalizeAgentActivityDisplayMode(ui.agentActivityDisplayMode),
        workspaceStatuses: normalizeWorkspaceStatuses(ui.workspaceStatuses),
        workspaceBoardOpacity: clampWorkspaceBoardOpacity(ui.workspaceBoardOpacity),
        workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(ui.workspaceBoardColumnWidth),
        syncTaskStatusFromWorkspaceBoard: ui.syncTaskStatusFromWorkspaceBoard === true,
        statusBarItems: statusBarItemsWithGrok,
        statusBarVisible: ui.statusBarVisible ?? true,
        usagePercentageDisplay: normalizeUsagePercentageDisplay(ui.usagePercentageDisplay),
        statusBarUsageMode: normalizeStatusBarUsageMode(ui.statusBarUsageMode),
        // Why: default true so existing users see the pet on first enabling the flag; only an explicit Hide persists false.
        petVisible: ui.petVisible ?? ui.sidekickVisible ?? true,
        petSize: clampPetSize(ui.petSize ?? ui.sidekickSize ?? PET_SIZE_DEFAULT),
        customPets,
        // Why: fall back to default when the persisted id is unknown (e.g. custom pet removed elsewhere) so the overlay renders.
        petId: ((): string => {
          const id = petId
          if (typeof id !== 'string') {
            return DEFAULT_PET_ID
          }
          if (isBundledPetId(id)) {
            return id
          }
          if (customPets.some((m) => m.id === id)) {
            return id
          }
          return DEFAULT_PET_ID
        })(),
        dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
        updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
        browserDefaultUrl: ui.browserDefaultUrl ?? null,
        browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
        browserDefaultZoomLevel: normalizeBrowserPageZoomLevel(ui.browserDefaultZoomLevel),
        browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
        taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
        featureTipsSeenIds: normalizeFeatureTipIds(ui.featureTipsSeenIds),
        featureInteractions: normalizeFeatureInteractions(ui.featureInteractions),
        contextualToursSeenIds: normalizeContextualTourIds(ui.contextualToursSeenIds),
        contextualToursAutoEligible:
          typeof ui.contextualToursAutoEligible === 'boolean'
            ? ui.contextualToursAutoEligible
            : null,
        trustedOrcaHooks: hydrateTrustedOrcaHooks(ui.trustedOrcaHooks, validRepoIds),
        setupScriptPromptDismissedRepoIds:
          validRepoIds.size === 0
            ? sanitizeSetupScriptPromptDismissals(ui.setupScriptPromptDismissedRepoIds)
            : filterSetupScriptPromptDismissalsToValidRepos(
                ui.setupScriptPromptDismissedRepoIds,
                validRepoIds
              ),
        setupGuideSidebarDismissed: ui.setupGuideSidebarDismissed === true,
        setupGuideBrowserMilestoneMigrated: ui.setupGuideBrowserMilestoneMigrated === true,
        setupGuideBrowserMilestoneLegacyComplete:
          ui.setupGuideBrowserMilestoneLegacyComplete === true,
        browserImportHintHidden: ui.browserImportHintHidden === true,
        mobileEmulatorTabIntroDismissed: ui.mobileEmulatorTabIntroDismissed === true,
        mobileEmulatorAgentSetupDismissed: ui.mobileEmulatorAgentSetupDismissed === true,
        projectOrderManualDefaultNoticeDismissed:
          ui.projectOrderManualDefaultNoticeDismissed === true,
        // Why: treat only explicit true as dismissed so a false from migration still surfaces.
        usagePercentageDisplayChangeNoticeDismissed:
          ui.usagePercentageDisplayChangeNoticeDismissed === true,
        // Why: default false so existing users still see the CTA; only explicit dismissal persists true.
        usageEmptyStateDismissed: ui.usageEmptyStateDismissed === true,
        // Why: stale acks are inert (paneKey reuse beats them via stateStartedAt); sanitizer bounds growth past HYDRATE_MAX_AGE_MS.
        acknowledgedAgentsByPaneKey: sanitizeAcknowledgedAgentsByPaneKey(
          ui.acknowledgedAgentsByPaneKey
        ),
        workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
          ui.workspaceCleanup?.dismissals
        ),
        // Why: restore only on startup; on 'sync' broadcasts it would clobber the window's current per-window view.
        activeView:
          source === 'startup'
            ? sanitizeHydratedActiveView(ui.activeView, s.settings?.experimentalActivity === true)
            : s.activeView,
        persistedUIReady: true
      }
      // Why: return the same ref on identical hydration so App's debounced writer doesn't echo it back to main.
      return hydratedUIPartialMatchesState(s, hydrated) ? s : hydrated
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => {
    const prevState = get().updateStatus.state
    const update: Partial<
      Pick<
        UISlice,
        'updateStatus' | 'updateChangelog' | 'updateCardCollapsed' | 'updateUserInitiatedCycle'
      >
    > = {
      updateStatus: status
    }
    if (status.state === 'checking') {
      update.updateUserInitiatedCycle = status.userInitiated === true
    } else if (status.state === 'idle') {
      update.updateUserInitiatedCycle = false
    }
    if (status.state === 'available') {
      // Why: always overwrite (even with null) so a prior version's changelog can't leak into a later simple-mode update.
      update.updateChangelog = status.changelog ?? null
    } else if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      // Why: reset on cycle-boundary states so stale rich content from a previous cycle can't resurface.
      update.updateChangelog = null
    }
    // 'downloading'/'downloaded'/'error': leave updateChangelog untouched to keep the original 'available' content.
    if (status.state !== prevState) {
      // Why: re-surface the card on each phase transition so a collapsed `downloading` doesn't bury `downloaded`/`error`.
      update.updateCardCollapsed = false
    }
    set(update)
  },
  updateChangelog: null,
  updateUserInitiatedCycle: false,
  dismissedUpdateVersion: null,
  clearDismissedUpdateVersion: () => {
    set({ dismissedUpdateVersion: null })
  },
  dismissUpdate: (versionOverride?: string) =>
    set((s) => {
      // Why: the 'error' variant has no version field, so the card passes it via versionOverride.
      const dismissedUpdateVersion =
        versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null)
      const activeNudgeId =
        'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null
      // Why: persist dismissal so relaunch doesn't immediately re-show the same card until a newer release.
      void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
      // Why: only consume the nudge campaign for cards from a nudge cycle, not ordinary dismissals.
      if (activeNudgeId) {
        void window.api.updater.dismissNudge().catch(console.error)
      }
      return { dismissedUpdateVersion, updateUserInitiatedCycle: false }
    }),
  updateCardCollapsed: false,
  setUpdateCardCollapsed: (collapsed) => set({ updateCardCollapsed: collapsed }),
  updateReassuranceSeen: false,
  markUpdateReassuranceSeen: () => {
    void window.api.ui.set({ updateReassuranceSeen: true }).catch(console.error)
    set({ updateReassuranceSeen: true })
  },
  isFullScreen: false,
  setIsFullScreen: (v) => set({ isFullScreen: v }),
  browserDefaultUrl: null,
  setBrowserDefaultUrl: (url) => {
    void window.api.ui.set({ browserDefaultUrl: url }).catch(console.error)
    set({ browserDefaultUrl: url })
  },
  browserDefaultSearchEngine: null,
  setBrowserDefaultSearchEngine: (engine) => {
    void window.api.ui.set({ browserDefaultSearchEngine: engine }).catch(console.error)
    set({ browserDefaultSearchEngine: engine })
  },
  browserDefaultZoomLevel: DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  setBrowserDefaultZoomLevel: (level) => {
    const normalized = normalizeBrowserPageZoomLevel(level)
    void window.api.ui.set({ browserDefaultZoomLevel: normalized }).catch(console.error)
    set({ browserDefaultZoomLevel: normalized })
  },
  browserKagiSessionLink: null,
  setBrowserKagiSessionLink: (link) => {
    const normalized = link ? normalizeKagiSessionLink(link) : null
    void window.api.ui.set({ browserKagiSessionLink: normalized }).catch(console.error)
    set({ browserKagiSessionLink: normalized })
  }
})
