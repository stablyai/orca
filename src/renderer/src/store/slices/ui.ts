/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import {
  findPrevLiveNonTaskStackHistoryIndex,
  findPrevLiveWorktreeHistoryIndex
} from './worktree-nav-history'
import type {
  ChangelogData,
  CustomPet,
  GitHubWorkItem,
  LinearIssue,
  PersistedTrustedOrcaHooks,
  PersistedUIState,
  StatusBarItem,
  TaskProvider,
  TaskResumeState,
  TaskViewPresetId,
  TuiAgent,
  UpdateStatus,
  WorkspaceGroup,
  WorkspaceStatusDefinition,
  WorktreeCardProperty
} from '../../../../shared/types'
import { PET_SIZE_DEFAULT, PET_SIZE_MAX, PET_SIZE_MIN } from '../../../../shared/types'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  type WorkspaceCleanupDismissal
} from '../../../../shared/workspace-cleanup'
import { normalizeFeatureTipIds, type FeatureTipId } from '../../../../shared/feature-tips'
import {
  normalizeFeatureInteractions,
  type FeatureInteractionId,
  type FeatureInteractionState
} from '../../../../shared/feature-interactions'
import { PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'
import {
  normalizeVisibleTaskProviders,
  restoreAvailableDefaultTaskProvider,
  resolveVisibleTaskProvider
} from '../../../../shared/task-providers'
import {
  DEFAULT_HIDE_SLEEPING_WORKSPACES,
  DEFAULT_SHOW_SLEEPING_WORKSPACES,
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES,
  normalizeWorktreeCardProperties
} from '../../../../shared/constants'
import {
  WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  clampWorkspaceBoardColumnWidth,
  clampWorkspaceBoardOpacity,
  cloneDefaultWorkspaceStatuses,
  normalizeWorkspaceBoardCompact,
  normalizeWorkspaceStatuses
} from '../../../../shared/workspace-statuses'
import { normalizeWorkspaceGroups } from '../../../../shared/workspace-groups'
import { normalizeKagiSessionLink } from '../../../../shared/browser-url'
import type { OrcaHookScriptKind } from '../../lib/orca-hook-trust'
import { DEFAULT_PET_ID, isBundledPetId } from '../../components/pet/pet-models'
import { revokeCustomPetBlobUrl } from '../../components/pet/pet-blob-cache'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { WorkspacePortScanResult } from '../../../../shared/workspace-ports'

export type PendingSidebarWorktreeReveal = {
  worktreeId: string
  behavior: 'auto' | 'smooth'
  highlight?: boolean
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

function clampPetSize(size: number): number {
  if (!Number.isFinite(size)) {
    return PET_SIZE_DEFAULT
  }
  return Math.max(PET_SIZE_MIN, Math.min(PET_SIZE_MAX, Math.round(size)))
}

// Why: mirrors the preset→query mapping used by TaskPage's preset buttons.
// Keeping a local copy here avoids a store ↔ lib circular import while letting
// openTaskPage warm exactly the cache key the page will read on mount.
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
    default:
      return 'is:issue is:open'
  }
}

// Why: persisted UI state pre-dated the consolidation of `memory` + `sessions`
// into a single `resource-usage` entry. Rewrite legacy ids in place and
// de-duplicate. We leave unknown ids alone so a downgrade→upgrade cycle
// doesn't strip a newer build's ids out of the user's settings.
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

function normalizePersistedRightSidebarTab(
  tab: PersistedUIState['rightSidebarTab'] | unknown
): PersistedUIState['rightSidebarTab'] {
  if (
    tab === 'explorer' ||
    tab === 'search' ||
    tab === 'source-control' ||
    tab === 'checks' ||
    tab === 'ports'
  ) {
    return tab
  }
  return 'explorer'
}

const MIN_SIDEBAR_WIDTH = 220
const MAX_LEFT_SIDEBAR_WIDTH = 500
// Why: the right sidebar drag-resize is window-relative (see right-sidebar
// component), so persisted widths can legitimately be well above the old 500px
// cap on wide displays. Use a large hard ceiling purely as a safety net for
// corrupted/manually-edited values rather than as a product limit.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000
const LINEAR_TASK_PREFETCH_LIMIT = 36
// Why: bound disk growth for acknowledgedAgentsByPaneKey across hard quits —
// in-session cleanup (agent-status.ts) prunes on pane lifecycle, but crash/
// forced-kill paths leave entries pinned. Mirrors HYDRATE_MAX_AGE_MS in
// src/main/agent-hooks/server.ts for parallel reasoning with the sibling
// hook-status entries these acks pair with.
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

function filterTrustedOrcaHooksToValidRepos(
  trust: PersistedTrustedOrcaHooks,
  validRepoIds: Set<string>
): PersistedTrustedOrcaHooks {
  const next: PersistedTrustedOrcaHooks = {}
  for (const [repoId, entry] of Object.entries(trust)) {
    if (validRepoIds.has(repoId)) {
      next[repoId] = entry
    }
  }
  return next
}

function filterRepoIdListToValidRepos(value: unknown, validRepoIds: Set<string>): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const next: string[] = []
  for (const repoId of value) {
    if (typeof repoId === 'string' && validRepoIds.has(repoId) && !next.includes(repoId)) {
      next.push(repoId)
    }
  }
  return next
}

function sanitizePersistedSidebarWidth(width: unknown, fallback: number, maxWidth: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
}

// Why: persisted JSON can be tampered with or carry legacy/corrupt shapes.
// Reject arrays (typeof [] === 'object'), prototype-pollution keys, and
// non-positive-finite values; drop entries past the TTL so hard-quit leaks
// don't accumulate forever.
function sanitizeAcknowledgedAgentsByPaneKey(value: unknown): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const cutoff = Date.now() - HYDRATE_MAX_AGE_MS
  const out: Record<string, number> = {}
  for (const [key, ackAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key !== 'string') {
      continue
    }
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
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
  if (typeof input.linearQuery === 'string') {
    next.linearQuery = input.linearQuery
  }

  return Object.keys(next).length > 0 ? next : undefined
}

export type UISlice = {
  sidebarOpen: boolean
  sidebarWidth: number
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  setSidebarWidth: (width: number) => void
  /** Per-agent "I've looked at this" timestamps, keyed by paneKey. Set when
   *  the user clicks an agent row or its parent workspace card from the
   *  dashboard. A row is considered unvisited when no ack exists OR the
   *  agent's current stateStartedAt is newer than the last ack (i.e. the
   *  agent has transitioned state since the user last saw it). Persisted
   *  via PersistedUIState because agent rows themselves now survive restart —
   *  without this, rows you'd already visited come back bold on relaunch. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  unacknowledgeAgents: (paneKeys: string[]) => void
  activeView:
    | 'terminal'
    | 'settings'
    | 'tasks'
    | 'activity'
    | 'automations'
    | 'space'
    | 'skills'
    | 'mobile'
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
    openGitHubInitialTab?: 'conversation' | 'checks' | 'files'
    openLinearIssue?: LinearIssue
  }
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  githubTaskDrawerWorkItem: GitHubWorkItem | null
  setGithubTaskDrawerWorkItem: (item: GitHubWorkItem | null) => void
  newWorkspaceDraft: {
    repoId: string | null
    name: string
    prompt: string
    note: string
    attachments: string[]
    linkedWorkItem: {
      type: 'issue' | 'pr' | 'mr'
      number: number
      title: string
      url: string
    } | null
    agent: TuiAgent
    linkedIssue: string
    linkedPR: number | null
    /** GitLab parallels — number for an issue, iid for an MR. Optional so
     *  drafts saved before GitLab support keep loading without migration. */
    linkedGitLabIssue?: number | null
    linkedGitLabMR?: number | null
    // Why: repo-scoped start ref selected via the "Start from" picker.
    // Absent means "use the repo's effective base ref".
    baseBranch?: string
  } | null
  openTaskPage: (data?: UISlice['taskPageData']) => void
  closeTaskPage: () => void
  openActivityPage: () => void
  closeActivityPage: () => void
  selectedAutomationId: string | null
  setSelectedAutomationId: (id: string | null) => void
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
    pane:
      | 'general'
      | 'integrations'
      | 'accounts'
      | 'browser'
      | 'git'
      | 'appearance'
      | 'input'
      | 'tasks'
      | 'floating-workspace'
      | 'terminal'
      | 'quick-commands'
      | 'notifications'
      | 'computer-use'
      | 'developer-permissions'
      | 'privacy'
      | 'shortcuts'
      | 'stats'
      | 'repo'
      | 'agents'
      | 'voice'
      | 'experimental'
      | 'orchestration'
      | 'servers'
      | 'mobile'
      | 'ssh'
    repoId: string | null
    sectionId?: string
    intent?: 'add-quick-command'
  } | null
  openSettingsTarget: (target: NonNullable<UISlice['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'confirm-add-project-from-folder'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'workspace-cleanup'
    | 'project-added'
    | 'worktree-visibility'
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
  recordFeatureInteraction: (id: FeatureInteractionId) => void
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
  groupBy: 'none' | 'workspace-status' | 'repo' | 'pr-status' | 'group'
  setGroupBy: (g: UISlice['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo' | 'manual'
  setSortBy: (s: UISlice['sortBy']) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  showSleepingWorkspaces: boolean
  setShowSleepingWorkspaces: (v: boolean) => void
  hideDefaultBranchWorkspace: boolean
  setHideDefaultBranchWorkspace: (v: boolean) => void
  filterRepoIds: string[]
  setFilterRepoIds: (ids: string[]) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  toggleWorktreeCardProperty: (prop: WorktreeCardProperty) => void
  workspaceStatuses: WorkspaceStatusDefinition[]
  setWorkspaceStatuses: (statuses: WorkspaceStatusDefinition[]) => void
  workspaceGroups: WorkspaceGroup[]
  setWorkspaceGroups: (groups: WorkspaceGroup[]) => void
  workspaceBoardOpacity: number
  setWorkspaceBoardOpacity: (opacity: number) => void
  workspaceBoardCompact: boolean
  setWorkspaceBoardCompact: (compact: boolean) => void
  workspaceBoardColumnWidth: number
  setWorkspaceBoardColumnWidth: (width: number) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  workspacePortScan: { key: string; result: WorkspacePortScanResult } | null
  workspacePortScanRefreshing: boolean
  setWorkspacePortScan: (scan: { key: string; result: WorkspacePortScanResult } | null) => void
  setWorkspacePortScanRefreshing: (refreshing: boolean) => void
  /** Whether the experimental pet overlay is currently visible. Persisted
   *  so "Hide pet" from the status-bar menu survives reload. Independent
   *  of the experimentalPet settings flag — the feature flag gates
   *  whether the overlay can ever render; this controls whether it does now. */
  petVisible: boolean
  setPetVisible: (v: boolean) => void
  /** Which pet is active — either a bundled id or a custom UUID.
   *  Persisted alongside petVisible via the PersistedUIState pipeline. */
  petId: string
  setPetId: (id: string) => void
  /** User-uploaded pet images. Metadata only — bytes live in main's userData. */
  customPets: CustomPet[]
  addCustomPet: (model: CustomPet) => void
  removeCustomPet: (id: string) => void
  /** Pet overlay size in CSS pixels (square). User-adjustable from the
   *  status-bar menu so a too-big imported sprite isn't a stuck-on-screen
   *  problem. */
  petSize: number
  setPetSize: (size: number) => void
  pendingRevealWorktree: PendingSidebarWorktreeReveal | null
  revealWorktreeInSidebar: (
    worktreeId: string,
    options?: {
      behavior?: PendingSidebarWorktreeReveal['behavior']
      highlight?: boolean
    }
  ) => void
  clearPendingRevealWorktreeId: () => void
  // Why: lets the SourceControl sidebar request that the diff editor scroll
  // to a specific note. Cleared by the diff decorator after it reveals the
  // line, so the same id can be requested again later without the surface
  // seeing a stale value.
  scrollToDiffCommentId: string | null
  setScrollToDiffCommentId: (id: string | null) => void
  persistedUIReady: boolean
  uiZoomLevel: number
  setUIZoomLevel: (level: number) => void
  editorFontZoomLevel: number
  setEditorFontZoomLevel: (level: number) => void
  hydratePersistedUI: (ui: PersistedUIState) => void
  updateStatus: UpdateStatus
  setUpdateStatus: (status: UpdateStatus) => void
  // Why: cached changelog from the last 'available' status so the card still has
  // rich content (title/media/description) during downloading, error, and downloaded
  // states. Cleared on idle/checking/not-available to prevent stale leakage.
  updateChangelog: ChangelogData | null
  dismissedUpdateVersion: string | null
  dismissUpdate: (versionOverride?: string) => void
  clearDismissedUpdateVersion: () => void
  // Why: ephemeral and renderer-only — never persisted and never crosses IPC.
  // Resets every session and on every phase transition (see setUpdateStatus).
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
  browserKagiSessionLink: string | null
  setBrowserKagiSessionLink: (link: string | null) => void
}

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set, get) => ({
  sidebarOpen: true,
  sidebarWidth: 280,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  setSidebarWidth: (width) => set({ sidebarWidth: width }),

  acknowledgedAgentsByPaneKey: {},
  acknowledgeAgents: (paneKeys) =>
    set((s) => {
      if (paneKeys.length === 0) {
        return s
      }
      const now = Date.now()
      // Why: only allocate a new map (and emit a store update) if at least
      // one ack is actually moving forward. Comparing `prev < now` instead
      // of `prev !== now` matters because stored values are historical
      // timestamps and `Date.now()` advances every millisecond — a strict-
      // inequality guard would fire on every call and rewrite the map on
      // every dashboard click or auto-ack tick, forcing every subscriber
      // (all agent rows, the SidebarHeader count, etc.) to re-render.
      let next: Record<string, number> | null = null
      for (const key of paneKeys) {
        const prev = s.acknowledgedAgentsByPaneKey[key] ?? 0
        if (prev < now) {
          if (next === null) {
            next = { ...s.acknowledgedAgentsByPaneKey }
          }
          next[key] = now
        }
      }
      return next ? { acknowledgedAgentsByPaneKey: next } : s
    }),
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
  openTaskPage: (data = {}) => {
    get().recordFeatureInteraction?.('tasks')
    // Why: record a Tasks visit in the shared back/forward history so the
    // titlebar Back/Forward buttons can return to Tasks. All task-source
    // variants (github/linear presets) collapse to a single 'tasks' entry;
    // the slice's adjacent-entry dedupe drops re-opens. No isNavigatingHistory
    // guard needed — back-to-Tasks routes through setActiveView('tasks') and
    // never re-enters openTaskPage.
    const detailEntry = data.openGitHubWorkItem
      ? ({
          kind: 'task-detail',
          source: 'github',
          workItem: data.openGitHubWorkItem,
          initialTab: data.openGitHubInitialTab
        } as const)
      : data.openLinearIssue
        ? ({
            kind: 'task-detail',
            source: 'linear',
            issue: data.openLinearIssue
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
    // Why: prefetch the GitHub work-item list in parallel with React's first
    // render of the TaskPage — by the time the page's own effect runs, the SWR
    // cache is either already populated or the request is in-flight and will
    // be deduped. This removes ~300–800ms of perceived latency on initial
    // page load.
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
      // Why: must match the exact query TaskPage's resume effect mounts with,
      // otherwise the warm cache key (e.g. 'is:issue is:open') misses the
      // page's actual fetch key and the prefetch is wasted. When the user has
      // an explicit custom search (preset === null), preserve it so both sides
      // agree.
      const query =
        resume?.githubItemsPreset === null
          ? (resume.githubItemsQuery ?? '').trim()
          : presetToQuery(resume?.githubItemsPreset ?? defaultPreset)
      for (const repo of selectedRepos) {
        state.prefetchWorkItems(repo.id, repo.path, PER_REPO_FETCH_LIMIT, query)
      }
    }
    if (resolvedSource === 'linear' && typeof state.prefetchLinearIssues === 'function') {
      const resume = state.taskResumeState
      const query = (resume?.linearQuery ?? '').trim()
      if (query) {
        state.prefetchLinearIssues({ kind: 'search', query, limit: LINEAR_TASK_PREFETCH_LIMIT })
      } else {
        state.prefetchLinearIssues({
          kind: 'list',
          filter: resume?.linearPreset ?? 'all',
          limit: LINEAR_TASK_PREFETCH_LIMIT
        })
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
      // Why: Esc-close from Tasks must rewind the history index if we're
      // currently parked on a 'tasks' entry. Without this, A → Tasks → Esc
      // leaves the index at the 'tasks' entry, making Back a visual no-op
      // (activator re-activates A) and Forward re-opens Tasks. If there is no
      // earlier live entry (e.g. history is just ['tasks']), leave the index
      // at 0 — setting it to -1 would lose the only forward target, while the
      // resulting Back visual no-op self-heals as soon as a real visit records
      // a new entry. closeTaskPage never runs from the history-nav path, so no
      // isNavigatingHistory guard is needed.
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
  openAutomationsPage: () => {
    get().recordFeatureInteraction?.('automations')
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
  openSpacePage: () =>
    set((state) => ({
      activeView: 'space',
      previousViewBeforeSpace:
        state.activeView === 'space' ? state.previousViewBeforeSpace : state.activeView
    })),
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
  openSettingsPage: () =>
    set((state) => ({
      activeView: 'settings',
      // Why: Settings is a temporary detour from either terminal or the
      // full-page tasks view. Preserve the originating view so the Settings
      // back action restores an in-progress workspace draft instead of always
      // dumping the user into terminal.
      previousViewBeforeSettings:
        state.activeView === 'settings' ? state.previousViewBeforeSettings : state.activeView
    })),
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

  activeModal: 'none',
  modalData: {},
  openModal: (modal, data = {}) => {
    if (modal === 'new-workspace-composer' || modal === 'add-repo' || modal === 'create-worktree') {
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
  recordFeatureInteraction: (id) =>
    set((s) => {
      if (!s.persistedUIReady) {
        return s
      }
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
                )
              }))
            })
          : window.api.ui.set({ featureInteractions: next })
        persist.catch(console.error)
      }
      return { featureInteractions: next }
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
      if (!repoId || s.setupScriptPromptDismissedRepoIds.includes(repoId)) {
        return s
      }
      const next = [...s.setupScriptPromptDismissedRepoIds, repoId]
      window.api.ui.set({ setupScriptPromptDismissedRepoIds: next }).catch(console.error)
      return { setupScriptPromptDismissedRepoIds: next }
    }),

  groupBy: 'repo',
  // Why: group keys are mode-specific (e.g. repo id vs PR status), so
  // collapsed state from one mode is meaningless in another. Clearing
  // also prevents unbounded accumulation of stale keys across mode switches.
  setGroupBy: (g) => {
    window.api.ui.set({ groupBy: g, collapsedGroups: [] }).catch(console.error)
    set({ groupBy: g, collapsedGroups: new Set<string>() })
  },

  sortBy: 'recent',
  setSortBy: (s) => set({ sortBy: s }),

  showActiveOnly: false,
  setShowActiveOnly: (v) => set({ showActiveOnly: v }),

  showSleepingWorkspaces: DEFAULT_SHOW_SLEEPING_WORKSPACES,
  setShowSleepingWorkspaces: (v) => set({ showSleepingWorkspaces: v }),

  hideDefaultBranchWorkspace: false,
  setHideDefaultBranchWorkspace: (v) => set({ hideDefaultBranchWorkspace: v }),

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
  toggleWorktreeCardProperty: (prop) =>
    set((s) => {
      const current = normalizeWorktreeCardProperties(s.worktreeCardProperties)
      const next = current.includes(prop) ? current.filter((p) => p !== prop) : [...current, prop]
      // Why: retired property toggles no longer exist, so their fields must
      // stay visible even if an older saved preference hid them.
      const updated = normalizeWorktreeCardProperties(next)
      window.api.ui.set({ worktreeCardProperties: updated }).catch(console.error)
      return { worktreeCardProperties: updated }
    }),

  workspaceStatuses: cloneDefaultWorkspaceStatuses(),
  setWorkspaceStatuses: (statuses) => {
    const normalized = normalizeWorkspaceStatuses(statuses)
    window.api.ui.set({ workspaceStatuses: normalized }).catch(console.error)
    set({ workspaceStatuses: normalized })
  },

  workspaceGroups: [],
  setWorkspaceGroups: (groups) => {
    const normalized = normalizeWorkspaceGroups(groups)
    window.api.ui.set({ workspaceGroups: normalized }).catch(console.error)
    set({ workspaceGroups: normalized })
  },

  workspaceBoardOpacity: 1,
  setWorkspaceBoardOpacity: (opacity) => {
    const clamped = clampWorkspaceBoardOpacity(opacity)
    window.api.ui.set({ workspaceBoardOpacity: clamped }).catch(console.error)
    set({ workspaceBoardOpacity: clamped })
  },

  workspaceBoardCompact: false,
  setWorkspaceBoardCompact: (compact) => {
    const normalized = normalizeWorkspaceBoardCompact(compact)
    window.api.ui.set({ workspaceBoardCompact: normalized }).catch(console.error)
    set({ workspaceBoardCompact: normalized })
  },

  workspaceBoardColumnWidth: WORKSPACE_BOARD_COLUMN_WIDTH_DEFAULT,
  setWorkspaceBoardColumnWidth: (width) => {
    const clamped = clampWorkspaceBoardColumnWidth(width)
    window.api.ui.set({ workspaceBoardColumnWidth: clamped }).catch(console.error)
    set({ workspaceBoardColumnWidth: clamped })
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
  workspacePortScan: null,
  workspacePortScanRefreshing: false,
  setWorkspacePortScan: (scan) => set({ workspacePortScan: scan }),
  setWorkspacePortScanRefreshing: (refreshing) => set({ workspacePortScanRefreshing: refreshing }),

  // Why: default true so a user who enables experimentalPet sees the
  // pet immediately. Hide pet from the status-bar menu flips this
  // to false; the value is persisted via the standard PersistedUIState pipeline.
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
      // Why: if the user removes the currently-active custom pet, fall
      // back to the bundled default so the overlay doesn't render nothing.
      const fallback = s.petId === id ? DEFAULT_PET_ID : s.petId
      // Why: send a single combined IPC update so customPets and
      // petId persist atomically when both change.
      const ipcPayload: { customPets: CustomPet[]; petId?: string } = {
        customPets: next
      }
      if (fallback !== s.petId) {
        ipcPayload.petId = fallback
      }
      window.api.ui.set(ipcPayload).catch(console.error)
      // Why: revoke the cached blob: URL so the underlying Blob is released;
      // otherwise it stays in memory for the rest of the session.
      revokeCustomPetBlobUrl(id)
      // Why: best-effort — the bytes are owned by main. If the disk delete
      // fails, the orphaned image stays in userData; each import uses a fresh
      // UUID so the file won't be hit again, and the renderer's metadata
      // index no longer references it.
      window.api.pet.delete(id, target.fileName, target.kind).catch(console.error)
      const partial: Partial<UISlice> = { customPets: next }
      if (fallback !== s.petId) {
        partial.petId = fallback
      }
      return partial
    }),

  pendingRevealWorktree: null,
  revealWorktreeInSidebar: (worktreeId, options) =>
    set({
      pendingRevealWorktree: {
        worktreeId,
        behavior: options?.behavior ?? 'smooth',
        ...(options?.highlight ? { highlight: true } : {})
      }
    }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktree: null }),
  scrollToDiffCommentId: null,
  setScrollToDiffCommentId: (id) => set({ scrollToDiffCommentId: id }),
  persistedUIReady: false,
  uiZoomLevel: 0,
  setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
  editorFontZoomLevel: 0,
  setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),

  hydratePersistedUI: (ui) =>
    set((s) => {
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
      // Why: persisted UI from pre-rename builds used sidekick* keys. Read
      // those only as fallbacks so new pet* writes win immediately after upgrade.
      const customPets = Array.isArray(ui.customPets)
        ? ui.customPets
        : Array.isArray(ui.customSidekicks)
          ? ui.customSidekicks
          : []
      const petId = ui.petId ?? ui.sidekickId
      // Migration history:
      // v1: sort was called 'smart' internally
      // v2: renamed 'smart' → 'recent' (same weighted-score behavior)
      // v3: 'smart' reintroduced as the weighted-score sort, 'recent' becomes
      //     a last-activity sort (worktree.lastActivityAt descending). The
      //     one-shot migration from old 'recent' to 'smart' happens in the
      //     main process (persistence.ts load()) using the _sortBySmartMigrated
      //     flag — not here — so that users who intentionally select the new
      //     'recent' sort keep it across restarts.
      const sortBy = ui.sortBy
      const migratedStatusBarItems = migrateStatusBarItems(ui.statusBarItems)
      const statusBarItems =
        ui._portsStatusBarDefaultAdded || migratedStatusBarItems.includes('ports')
          ? migratedStatusBarItems
          : [...migratedStatusBarItems, 'ports' as const]
      if (!ui._portsStatusBarDefaultAdded && typeof window !== 'undefined') {
        window.api.ui
          .set({ statusBarItems, _portsStatusBarDefaultAdded: true })
          .catch(console.error)
      }
      return {
        // Why: persisted UI data comes from disk and may be stale, corrupted,
        // or manually edited. Clamp widths during hydration so invalid values
        // cannot push the renderer into broken layouts before the user drags a
        // sidebar again.
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
        rightSidebarOpen: typeof ui.rightSidebarOpen === 'boolean' ? ui.rightSidebarOpen : true,
        rightSidebarTab: normalizePersistedRightSidebarTab(ui.rightSidebarTab),
        groupBy: (ui.groupBy as UISlice['groupBy'] | 'parent') === 'parent' ? 'repo' : ui.groupBy,
        sortBy,
        // Why: Active-only was retired. Force the old persisted flag off so an
        // old profile cannot invisibly keep narrowing the workspace list.
        showActiveOnly: false,
        // Why: `hideSleepingWorkspaces` is the canonical negative-form filter.
        // Older positive-form keys are intentionally ignored so old profiles
        // start from the new default: sleeping workspaces visible.
        showSleepingWorkspaces: !(ui.hideSleepingWorkspaces ?? DEFAULT_HIDE_SLEEPING_WORKSPACES),
        hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
        filterRepoIds: (ui.filterRepoIds ?? []).filter((repoId) => validRepoIds.has(repoId)),
        collapsedGroups: new Set(ui.collapsedGroups ?? []),
        uiZoomLevel: ui.uiZoomLevel ?? 0,
        editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
        worktreeCardProperties: normalizeWorktreeCardProperties(ui.worktreeCardProperties),
        workspaceStatuses: normalizeWorkspaceStatuses(ui.workspaceStatuses),
        workspaceGroups: normalizeWorkspaceGroups(ui.workspaceGroups),
        workspaceBoardOpacity: clampWorkspaceBoardOpacity(ui.workspaceBoardOpacity),
        workspaceBoardCompact: normalizeWorkspaceBoardCompact(ui.workspaceBoardCompact),
        workspaceBoardColumnWidth: clampWorkspaceBoardColumnWidth(ui.workspaceBoardColumnWidth),
        statusBarItems,
        statusBarVisible: ui.statusBarVisible ?? true,
        // Why: absent → true so existing users see the pet the first time
        // they enable the experimental flag. Only an explicit Hide pet
        // dismissal persists a `false` value.
        petVisible: ui.petVisible ?? ui.sidekickVisible ?? true,
        petSize: clampPetSize(ui.petSize ?? ui.sidekickSize ?? PET_SIZE_DEFAULT),
        customPets,
        // Why: accept the persisted id if it matches a bundled pet or a
        // known custom one; otherwise fall back so the overlay never renders
        // nothing (e.g. custom pet was removed by another session).
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
        browserKagiSessionLink: normalizeKagiSessionLink(ui.browserKagiSessionLink ?? ''),
        taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
        featureTipsSeenIds: normalizeFeatureTipIds(ui.featureTipsSeenIds),
        featureInteractions: normalizeFeatureInteractions(ui.featureInteractions),
        trustedOrcaHooks: filterTrustedOrcaHooksToValidRepos(
          ui.trustedOrcaHooks ?? {},
          validRepoIds
        ),
        setupScriptPromptDismissedRepoIds: filterRepoIdListToValidRepos(
          ui.setupScriptPromptDismissedRepoIds,
          validRepoIds
        ),
        // Why: restore visited-row acks alongside the persisted hook entries
        // they pair with. Stale acks for paneKeys whose tab/PTY no longer
        // exists are inert (no row references them); a paneKey reuse stamps a
        // fresh stateStartedAt that beats the old ack via the ackAt <
        // stateStartedAt comparison in WorktreeCardAgents. Sanitizer drops
        // entries past HYDRATE_MAX_AGE_MS so hard-quit/crash paths that miss
        // the in-session cleanup in agent-status.ts can't accumulate forever.
        acknowledgedAgentsByPaneKey: sanitizeAcknowledgedAgentsByPaneKey(
          ui.acknowledgedAgentsByPaneKey
        ),
        workspaceCleanupDismissals: sanitizeWorkspaceCleanupDismissals(
          ui.workspaceCleanup?.dismissals
        ),
        persistedUIReady: true
      }
    }),

  updateStatus: { state: 'idle' },
  setUpdateStatus: (status) => {
    const prevState = get().updateStatus.state
    const update: Partial<
      Pick<UISlice, 'updateStatus' | 'updateChangelog' | 'updateCardCollapsed'>
    > = {
      updateStatus: status
    }
    if (status.state === 'available') {
      // Why: cache changelog from each 'available' payload so the card retains
      // rich content across downloading/error/downloaded transitions. Always
      // overwrite (even with null) to prevent a previous rich changelog from
      // leaking into a later simple-mode update for a different version.
      update.updateChangelog = status.changelog ?? null
    } else if (
      status.state === 'idle' ||
      status.state === 'checking' ||
      status.state === 'not-available'
    ) {
      // Why: reset on cycle-boundary states so stale rich content from a
      // previous update cycle cannot resurface.
      update.updateChangelog = null
    }
    // For 'downloading', 'downloaded', 'error': leave updateChangelog untouched
    // so the card can keep showing rich content from the original 'available'.
    if (status.state !== prevState) {
      // Why: re-surface the card on every phase transition so a prior collapse
      // of `downloading` doesn't bury the `downloaded`/`error` that follows.
      update.updateCardCollapsed = false
    }
    set(update)
  },
  updateChangelog: null,
  dismissedUpdateVersion: null,
  clearDismissedUpdateVersion: () => {
    set({ dismissedUpdateVersion: null })
  },
  dismissUpdate: (versionOverride?: string) =>
    set((s) => {
      // Why: the 'error' variant has no version field, so the card passes
      // the cached version explicitly via versionOverride.
      const dismissedUpdateVersion =
        versionOverride ?? ('version' in s.updateStatus ? (s.updateStatus.version ?? null) : null)
      const activeNudgeId =
        'activeNudgeId' in s.updateStatus ? (s.updateStatus.activeNudgeId ?? null) : null
      // Why: dismissing an update is user intent, not transient view state. Persist
      // the dismissed version so relaunching the app does not immediately re-show
      // the same reminder card until a newer release appears.
      void window.api.ui.set({ dismissedUpdateVersion }).catch(console.error)
      // Why: only dismiss the main-process nudge campaign when the visible card
      // actually came from a nudge-driven update cycle. Ordinary update dismissals
      // must not consume the active campaign state.
      if (activeNudgeId) {
        void window.api.updater.dismissNudge().catch(console.error)
      }
      return { dismissedUpdateVersion }
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
  browserKagiSessionLink: null,
  setBrowserKagiSessionLink: (link) => {
    const normalized = link ? normalizeKagiSessionLink(link) : null
    void window.api.ui.set({ browserKagiSessionLink: normalized }).catch(console.error)
    set({ browserKagiSessionLink: normalized })
  }
})
