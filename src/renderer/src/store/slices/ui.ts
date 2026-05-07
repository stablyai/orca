/* eslint-disable max-lines */
import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { findPrevLiveWorktreeHistoryIndex } from './worktree-nav-history'
import type {
  ChangelogData,
  CustomSidekick,
  PersistedTrustedOrcaHooks,
  PersistedUIState,
  StatusBarItem,
  TaskResumeState,
  TaskViewPresetId,
  TuiAgent,
  UpdateStatus,
  WorktreeCardProperty
} from '../../../../shared/types'
import {
  SIDEKICK_SIZE_DEFAULT,
  SIDEKICK_SIZE_MAX,
  SIDEKICK_SIZE_MIN
} from '../../../../shared/types'
import { PER_REPO_FETCH_LIMIT } from '../../../../shared/work-items'
import {
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES
} from '../../../../shared/constants'
import type { OrcaHookScriptKind } from '../../lib/orca-hook-trust'
import { DEFAULT_SIDEKICK_ID, isBundledSidekickId } from '../../components/sidekick/sidekick-models'
import { revokeCustomSidekickBlobUrl } from '../../components/sidekick/sidekick-blob-cache'
import { isGitRepoKind } from '../../../../shared/repo-kind'

function clampSidekickSize(size: number): number {
  if (!Number.isFinite(size)) {
    return SIDEKICK_SIZE_DEFAULT
  }
  return Math.max(SIDEKICK_SIZE_MIN, Math.min(SIDEKICK_SIZE_MAX, Math.round(size)))
}

// Why: mirrors the preset→query mapping used by TaskPage's preset buttons.
// Keeping a local copy here avoids a store ↔ lib circular import while letting
// openTaskPage warm exactly the cache key the page will read on mount.
function presetToQuery(presetId: TaskViewPresetId | null): string {
  switch (presetId) {
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
      return 'is:open'
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

const MIN_SIDEBAR_WIDTH = 220
const MAX_LEFT_SIDEBAR_WIDTH = 500
// Why: the right sidebar drag-resize is window-relative (see right-sidebar
// component), so persisted widths can legitimately be well above the old 500px
// cap on wide displays. Use a large hard ceiling purely as a safety net for
// corrupted/manually-edited values rather than as a product limit.
const MAX_RIGHT_SIDEBAR_WIDTH = 4000
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

function sanitizePersistedSidebarWidth(width: unknown, fallback: number, maxWidth: number): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) {
    return fallback
  }
  return Math.min(maxWidth, Math.max(MIN_SIDEBAR_WIDTH, width))
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
   *  agent has transitioned state since the user last saw it). Session-only
   *  — restart resets everyone to unvisited, which is harmless since the
   *  first visit after launch is a legitimate "need to see" moment. */
  acknowledgedAgentsByPaneKey: Record<string, number>
  acknowledgeAgents: (paneKeys: string[]) => void
  /** Per-worktree collapsed state for the inline agents section shown inside
   *  each workspace card. Session-only — a restart defaults back to expanded,
   *  which matches the expected default (people rarely want agents hidden
   *  across launches). */
  collapsedInlineAgentsByWorktreeId: Record<string, boolean>
  toggleInlineAgentsCollapsed: (worktreeId: string) => void
  activeView: 'terminal' | 'settings' | 'tasks'
  previousViewBeforeTasks: 'terminal' | 'settings'
  previousViewBeforeSettings: 'terminal' | 'tasks'
  setActiveView: (view: UISlice['activeView']) => void
  taskPageData: {
    preselectedRepoId?: string
    prefilledName?: string
    taskSource?: 'github' | 'linear'
  }
  taskResumeState: TaskResumeState | undefined
  setTaskResumeState: (updates: Partial<TaskResumeState>) => void
  newWorkspaceDraft: {
    repoId: string | null
    name: string
    prompt: string
    note: string
    attachments: string[]
    linkedWorkItem: {
      type: 'issue' | 'pr'
      number: number
      title: string
      url: string
    } | null
    agent: TuiAgent
    linkedIssue: string
    linkedPR: number | null
    // Why: repo-scoped start ref selected via the "Start from" picker.
    // Absent means "use the repo's effective base ref".
    baseBranch?: string
  } | null
  openTaskPage: (data?: UISlice['taskPageData']) => void
  closeTaskPage: () => void
  setNewWorkspaceDraft: (draft: NonNullable<UISlice['newWorkspaceDraft']>) => void
  clearNewWorkspaceDraft: () => void
  openSettingsPage: () => void
  closeSettingsPage: () => void
  settingsNavigationTarget: {
    pane:
      | 'general'
      | 'browser'
      | 'appearance'
      | 'terminal'
      | 'developer-permissions'
      | 'shortcuts'
      | 'repo'
      | 'agents'
      | 'accounts'
      | 'experimental'
      | 'ssh'
    repoId: string | null
    sectionId?: string
  } | null
  openSettingsTarget: (target: NonNullable<UISlice['settingsNavigationTarget']>) => void
  clearSettingsTarget: () => void
  activeModal:
    | 'none'
    | 'create-worktree'
    | 'edit-meta'
    | 'delete-worktree'
    | 'confirm-non-git-folder'
    | 'confirm-remove-folder'
    | 'add-repo'
    | 'quick-open'
    | 'worktree-palette'
    | 'new-workspace-composer'
    | 'confirm-orca-yaml-hooks'
  modalData: Record<string, unknown>
  openModal: (modal: UISlice['activeModal'], data?: Record<string, unknown>) => void
  closeModal: () => void
  trustedOrcaHooks: PersistedTrustedOrcaHooks
  markOrcaHookScriptConfirmed: (
    repoId: string,
    kind: OrcaHookScriptKind,
    contentHash: string
  ) => void
  markOrcaHookRepoAlwaysTrusted: (repoId: string) => void
  clearOrcaHookTrustForRepo: (repoId: string) => void
  groupBy: 'none' | 'repo' | 'pr-status'
  setGroupBy: (g: UISlice['groupBy']) => void
  sortBy: 'name' | 'smart' | 'recent' | 'repo'
  setSortBy: (s: UISlice['sortBy']) => void
  showActiveOnly: boolean
  setShowActiveOnly: (v: boolean) => void
  hideDefaultBranchWorkspace: boolean
  setHideDefaultBranchWorkspace: (v: boolean) => void
  filterRepoIds: string[]
  setFilterRepoIds: (ids: string[]) => void
  collapsedGroups: Set<string>
  toggleCollapsedGroup: (key: string) => void
  worktreeCardProperties: WorktreeCardProperty[]
  toggleWorktreeCardProperty: (prop: WorktreeCardProperty) => void
  statusBarItems: StatusBarItem[]
  toggleStatusBarItem: (item: StatusBarItem) => void
  statusBarVisible: boolean
  setStatusBarVisible: (v: boolean) => void
  /** Whether the experimental sidekick overlay is currently visible. Persisted
   *  so "Hide sidekick" from the status-bar menu survives reload. Independent
   *  of the experimentalSidekick settings flag — the feature flag gates
   *  whether the overlay can ever render; this controls whether it does now. */
  sidekickVisible: boolean
  setSidekickVisible: (v: boolean) => void
  /** Which sidekick is active — either a bundled id or a custom UUID.
   *  Persisted alongside sidekickVisible via the PersistedUIState pipeline. */
  sidekickId: string
  setSidekickId: (id: string) => void
  /** User-uploaded sidekick images. Metadata only — bytes live in main's userData. */
  customSidekicks: CustomSidekick[]
  addCustomSidekick: (model: CustomSidekick) => void
  removeCustomSidekick: (id: string) => void
  /** Sidekick overlay size in CSS pixels (square). User-adjustable from the
   *  status-bar menu so a too-big imported sprite isn't a stuck-on-screen
   *  problem. */
  sidekickSize: number
  setSidekickSize: (size: number) => void
  pendingRevealWorktreeId: string | null
  revealWorktreeInSidebar: (worktreeId: string) => void
  clearPendingRevealWorktreeId: () => void
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
  browserDefaultSearchEngine: 'google' | 'duckduckgo' | 'bing' | null
  setBrowserDefaultSearchEngine: (engine: 'google' | 'duckduckgo' | 'bing' | null) => void
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
  collapsedInlineAgentsByWorktreeId: {},
  toggleInlineAgentsCollapsed: (worktreeId) =>
    set((s) => {
      const current = s.collapsedInlineAgentsByWorktreeId[worktreeId] === true
      const next = { ...s.collapsedInlineAgentsByWorktreeId }
      if (current) {
        delete next[worktreeId]
      } else {
        next[worktreeId] = true
      }
      return { collapsedInlineAgentsByWorktreeId: next }
    }),

  activeView: 'terminal',
  previousViewBeforeTasks: 'terminal',
  previousViewBeforeSettings: 'terminal',
  setActiveView: (view) => set({ activeView: view }),
  taskPageData: {},
  taskResumeState: undefined,
  newWorkspaceDraft: null,
  openTaskPage: (data = {}) => {
    // Why: record a Tasks visit in the shared back/forward history so the
    // titlebar Back/Forward buttons can return to Tasks. All task-source
    // variants (github/linear presets) collapse to a single 'tasks' entry;
    // the slice's adjacent-entry dedupe drops re-opens. No isNavigatingHistory
    // guard needed — back-to-Tasks routes through setActiveView('tasks') and
    // never re-enters openTaskPage.
    get().recordViewVisit('tasks')
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
    const resolvedSource = data.taskSource ?? state.settings?.defaultTaskSource ?? 'github'
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
      // otherwise the warm cache key (e.g. 'is:open') misses the page's actual
      // fetch key (e.g. '') and the prefetch is wasted. When the user has an
      // explicit cleared custom search (preset === null), preserve the empty
      // query so both sides agree.
      const query =
        resume?.githubItemsPreset === null
          ? (resume.githubItemsQuery ?? '').trim()
          : presetToQuery(resume?.githubItemsPreset ?? defaultPreset)
      for (const repo of selectedRepos) {
        state.prefetchWorkItems(repo.id, repo.path, PER_REPO_FETCH_LIMIT, query)
      }
    }
  },
  setTaskResumeState: (updates) =>
    set((s) => {
      const next = { ...s.taskResumeState, ...updates }
      window.api.ui.set({ taskResumeState: next }).catch(console.error)
      return { taskResumeState: next }
    }),
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
      if (currentEntry === 'tasks') {
        const prev = findPrevLiveWorktreeHistoryIndex(state)
        if (prev !== null) {
          nextHistoryIndex = prev
        }
      }
      return {
        activeView: state.previousViewBeforeTasks,
        taskPageData: {},
        worktreeNavHistoryIndex: nextHistoryIndex
      }
    }),
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
    set((state) => ({
      activeView: state.previousViewBeforeSettings
    })),
  settingsNavigationTarget: null,
  openSettingsTarget: (target) => set({ settingsNavigationTarget: target }),
  clearSettingsTarget: () => set({ settingsNavigationTarget: null }),

  activeModal: 'none',
  modalData: {},
  openModal: (modal, data = {}) => set({ activeModal: modal, modalData: data }),
  closeModal: () => set({ activeModal: 'none', modalData: {} }),

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

  groupBy: 'repo',
  // Why: group keys are mode-specific (e.g. repo id vs PR status), so
  // collapsed state from one mode is meaningless in another. Clearing
  // also prevents unbounded accumulation of stale keys across mode switches.
  setGroupBy: (g) => {
    window.api.ui.set({ collapsedGroups: [] }).catch(console.error)
    set({ groupBy: g, collapsedGroups: new Set<string>() })
  },

  sortBy: 'recent',
  setSortBy: (s) => set({ sortBy: s }),

  showActiveOnly: false,
  setShowActiveOnly: (v) => set({ showActiveOnly: v }),

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
      const current = s.worktreeCardProperties || DEFAULT_WORKTREE_CARD_PROPERTIES
      const updated = current.includes(prop)
        ? current.filter((p) => p !== prop)
        : [...current, prop]
      window.api.ui.set({ worktreeCardProperties: updated }).catch(console.error)
      return { worktreeCardProperties: updated }
    }),

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

  // Why: default true so a user who enables experimentalSidekick sees the
  // sidekick immediately. Hide sidekick from the status-bar menu flips this
  // to false; the value is persisted via the standard PersistedUIState pipeline.
  sidekickVisible: true,
  setSidekickVisible: (v) => {
    window.api.ui.set({ sidekickVisible: v }).catch(console.error)
    set({ sidekickVisible: v })
  },

  sidekickId: DEFAULT_SIDEKICK_ID,
  setSidekickId: (id) => {
    window.api.ui.set({ sidekickId: id }).catch(console.error)
    set({ sidekickId: id })
  },

  sidekickSize: SIDEKICK_SIZE_DEFAULT,
  setSidekickSize: (size) => {
    const clamped = clampSidekickSize(size)
    window.api.ui.set({ sidekickSize: clamped }).catch(console.error)
    set({ sidekickSize: clamped })
  },

  customSidekicks: [],
  addCustomSidekick: (model) =>
    set((s) => {
      const next = [...s.customSidekicks.filter((m) => m.id !== model.id), model]
      window.api.ui.set({ customSidekicks: next }).catch(console.error)
      return { customSidekicks: next }
    }),
  removeCustomSidekick: (id) =>
    set((s) => {
      const target = s.customSidekicks.find((m) => m.id === id)
      if (!target) {
        return s
      }
      const next = s.customSidekicks.filter((m) => m.id !== id)
      // Why: if the user removes the currently-active custom sidekick, fall
      // back to the bundled default so the overlay doesn't render nothing.
      const fallback = s.sidekickId === id ? DEFAULT_SIDEKICK_ID : s.sidekickId
      // Why: send a single combined IPC update so customSidekicks and
      // sidekickId persist atomically when both change.
      const ipcPayload: { customSidekicks: CustomSidekick[]; sidekickId?: string } = {
        customSidekicks: next
      }
      if (fallback !== s.sidekickId) {
        ipcPayload.sidekickId = fallback
      }
      window.api.ui.set(ipcPayload).catch(console.error)
      // Why: revoke the cached blob: URL so the underlying Blob is released;
      // otherwise it stays in memory for the rest of the session.
      revokeCustomSidekickBlobUrl(id)
      // Why: best-effort — the bytes are owned by main. If the disk delete
      // fails, the orphaned image stays in userData; each import uses a fresh
      // UUID so the file won't be hit again, and the renderer's metadata
      // index no longer references it.
      window.api.sidekick.delete(id, target.fileName, target.kind).catch(console.error)
      const partial: Partial<UISlice> = { customSidekicks: next }
      if (fallback !== s.sidekickId) {
        partial.sidekickId = fallback
      }
      return partial
    }),

  pendingRevealWorktreeId: null,
  revealWorktreeInSidebar: (worktreeId) => set({ pendingRevealWorktreeId: worktreeId }),
  clearPendingRevealWorktreeId: () => set({ pendingRevealWorktreeId: null }),
  persistedUIReady: false,
  uiZoomLevel: 0,
  setUIZoomLevel: (level) => set({ uiZoomLevel: level }),
  editorFontZoomLevel: 0,
  setEditorFontZoomLevel: (level) => set({ editorFontZoomLevel: level }),

  hydratePersistedUI: (ui) =>
    set((s) => {
      const validRepoIds = new Set(s.repos.map((repo) => repo.id))
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
        groupBy: ui.groupBy,
        sortBy,
        // Why: "Active only" is part of the user's sidebar working set, not a
        // transient render detail. Restoring it on launch keeps the filtered
        // worktree list stable across restarts instead of silently widening it.
        showActiveOnly: ui.showActiveOnly,
        hideDefaultBranchWorkspace: ui.hideDefaultBranchWorkspace ?? false,
        filterRepoIds: (ui.filterRepoIds ?? []).filter((repoId) => validRepoIds.has(repoId)),
        collapsedGroups: new Set(ui.collapsedGroups ?? []),
        uiZoomLevel: ui.uiZoomLevel ?? 0,
        editorFontZoomLevel: ui.editorFontZoomLevel ?? 0,
        worktreeCardProperties: ui.worktreeCardProperties ?? [...DEFAULT_WORKTREE_CARD_PROPERTIES],
        statusBarItems: migrateStatusBarItems(ui.statusBarItems),
        statusBarVisible: ui.statusBarVisible ?? true,
        // Why: absent → true so existing users see the sidekick the first time
        // they enable the experimental flag. Only an explicit Hide sidekick
        // dismissal persists a `false` value.
        sidekickVisible: ui.sidekickVisible ?? true,
        sidekickSize: clampSidekickSize(ui.sidekickSize ?? SIDEKICK_SIZE_DEFAULT),
        customSidekicks: Array.isArray(ui.customSidekicks) ? ui.customSidekicks : [],
        // Why: accept the persisted id if it matches a bundled sidekick or a
        // known custom one; otherwise fall back so the overlay never renders
        // nothing (e.g. custom sidekick was removed by another session).
        sidekickId: ((): string => {
          const id = ui.sidekickId
          if (typeof id !== 'string') {
            return DEFAULT_SIDEKICK_ID
          }
          if (isBundledSidekickId(id)) {
            return id
          }
          const custom = Array.isArray(ui.customSidekicks) ? ui.customSidekicks : []
          if (custom.some((m) => m.id === id)) {
            return id
          }
          return DEFAULT_SIDEKICK_ID
        })(),
        dismissedUpdateVersion: ui.dismissedUpdateVersion ?? null,
        updateReassuranceSeen: ui.updateReassuranceSeen ?? false,
        browserDefaultUrl: ui.browserDefaultUrl ?? null,
        browserDefaultSearchEngine: ui.browserDefaultSearchEngine ?? null,
        taskResumeState: sanitizeTaskResumeState(ui.taskResumeState),
        trustedOrcaHooks: filterTrustedOrcaHooksToValidRepos(
          ui.trustedOrcaHooks ?? {},
          validRepoIds
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
  }
})
