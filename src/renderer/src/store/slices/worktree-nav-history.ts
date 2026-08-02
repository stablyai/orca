import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import { findWorktreeById } from './worktree-helpers'
import type { GitHubWorkItem, JiraIssue, LinearIssue } from '../../../../shared/types'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'

// Why: bound per-session history growth; 50 keeps goBack/goForward's linear scans cheap yet is never hit in normal use.
const MAX_HISTORY = 50

// Why: entries may be page sentinels, not just worktree IDs; names keep the "worktree" prefix for call-site stability.
export type WorktreeNavHistorySimpleViewEntry = 'tasks' | 'automations'
export type WorktreeNavHistoryTaskDetailEntry =
  | {
      kind: 'task-detail'
      source: 'github'
      workItem: GitHubWorkItem
      sourceContext?: TaskSourceContext | null
      initialTab?: 'conversation' | 'checks' | 'files'
    }
  | {
      kind: 'task-detail'
      source: 'linear'
      issue: LinearIssue
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'gitlab'
      workItem: GitLabWorkItem
      sourceContext?: TaskSourceContext | null
    }
  | {
      kind: 'task-detail'
      source: 'jira'
      issue: JiraIssue
      sourceContext?: TaskSourceContext | null
    }
export type WorktreeNavHistoryViewEntry =
  | WorktreeNavHistorySimpleViewEntry
  | WorktreeNavHistoryTaskDetailEntry
export type WorktreeNavHistoryEntry = string | WorktreeNavHistoryViewEntry

export type WorktreeNavHistorySlice = {
  // Linear history, oldest -> newest.
  worktreeNavHistory: WorktreeNavHistoryEntry[]
  // Index into worktreeNavHistory pointing at the active entry; -1 means empty.
  worktreeNavHistoryIndex: number
  // Why: true during goBack/goForward so recordWorktreeVisit skips re-recording a history-driven navigation.
  isNavigatingHistory: boolean

  recordWorktreeVisit: (worktreeId: string) => void
  recordViewVisit: (entry: WorktreeNavHistoryViewEntry) => void
  goBackWorktree: () => void
  goForwardWorktree: () => void
}

type ActivateFn = (worktreeId: string) => unknown
type ViewActivateFn = (entry: WorktreeNavHistoryViewEntry) => void

// Why: injected via setWorktreeNavActivator to avoid an import cycle (activation imports the store).
let activator: ActivateFn | null = null
let viewActivator: ViewActivateFn | null = null

export function setWorktreeNavActivator(fn: ActivateFn | null): void {
  activator = fn
}

// Why: injected to avoid an import cycle — the UI slice already depends on this module.
export function setWorktreeNavViewActivator(fn: ViewActivateFn | null): void {
  viewActivator = fn
}

// Why: view entries count as live unconditionally — findWorktreeById can't resolve page sentinels.
function isViewEntry(entry: WorktreeNavHistoryEntry): entry is WorktreeNavHistoryViewEntry {
  return entry === 'tasks' || entry === 'automations' || typeof entry === 'object'
}

function isTaskStackEntry(entry: WorktreeNavHistoryEntry): boolean {
  return entry === 'tasks' || (typeof entry === 'object' && entry.kind === 'task-detail')
}

function getHistoryEntryKey(entry: WorktreeNavHistoryEntry): string {
  if (typeof entry === 'string') {
    return entry === 'tasks' || entry === 'automations' ? `view:${entry}` : `worktree:${entry}`
  }
  if (entry.source === 'github') {
    const sourceScope =
      entry.sourceContext?.provider === 'github'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:github:${sourceScope}:${entry.workItem.repoId}:${entry.workItem.type}:${entry.workItem.number}:${entry.initialTab ?? 'conversation'}`
  }
  if (entry.source === 'gitlab') {
    const sourceScope =
      entry.sourceContext?.provider === 'gitlab'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:gitlab:${sourceScope}:${entry.workItem.repoId}:${entry.workItem.type}:${entry.workItem.number}`
  }
  if (entry.source === 'jira') {
    const sourceScope =
      entry.sourceContext?.provider === 'jira'
        ? getTaskSourceCacheScope(entry.sourceContext)
        : 'legacy'
    return `view:task-detail:jira:${sourceScope}:${entry.issue.siteId ?? 'selected'}:${entry.issue.key}`
  }
  const sourceScope =
    entry.sourceContext?.provider === 'linear'
      ? getTaskSourceCacheScope(entry.sourceContext)
      : 'legacy'
  return `view:task-detail:linear:${sourceScope}:${entry.issue.workspaceId ?? 'selected'}:${entry.issue.id}`
}

function isLiveEntry(entry: WorktreeNavHistoryEntry, state: AppState): boolean {
  if (isViewEntry(entry)) {
    return true
  }
  const workspaceScope = parseWorkspaceKey(entry)
  if (workspaceScope?.type === 'folder') {
    return state.folderWorkspaces.some(
      (workspace) => workspace.id === workspaceScope.folderWorkspaceId
    )
  }
  return findWorktreeById(state.worktreesByRepo, entry) !== undefined
}

function appendHistoryEntry(
  s: { worktreeNavHistory: WorktreeNavHistoryEntry[]; worktreeNavHistoryIndex: number },
  entry: WorktreeNavHistoryEntry
): { worktreeNavHistory: WorktreeNavHistoryEntry[]; worktreeNavHistoryIndex: number } {
  // Why: de-dup only against the current entry so A -> B -> A stays a valid stack.
  const current = s.worktreeNavHistory[s.worktreeNavHistoryIndex]
  if (current !== undefined && getHistoryEntryKey(current) === getHistoryEntryKey(entry)) {
    return s
  }

  // Truncate forward entries so appending starts a new branch.
  const truncated = s.worktreeNavHistory.slice(0, s.worktreeNavHistoryIndex + 1)
  truncated.push(entry)
  let nextIndex = s.worktreeNavHistoryIndex + 1

  // Why: shift index left by the eviction count so it still points at the just-appended entry.
  if (truncated.length > MAX_HISTORY) {
    const evict = truncated.length - MAX_HISTORY
    truncated.splice(0, evict)
    nextIndex = Math.max(0, nextIndex - evict)
  }

  return {
    worktreeNavHistory: truncated,
    worktreeNavHistoryIndex: nextIndex
  }
}

export function findPrevLiveWorktreeHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex - 1; i >= 0; i--) {
    if (isLiveEntry(state.worktreeNavHistory[i], state)) {
      return i
    }
  }
  return null
}

export function findPrevLiveNonTaskStackHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex - 1; i >= 0; i--) {
    const entry = state.worktreeNavHistory[i]
    if (!isTaskStackEntry(entry) && isLiveEntry(entry, state)) {
      return i
    }
  }
  return null
}

export function findNextLiveWorktreeHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex + 1; i < state.worktreeNavHistory.length; i++) {
    if (isLiveEntry(state.worktreeNavHistory[i], state)) {
      return i
    }
  }
  return null
}

export function canGoBackWorktreeHistory(state: AppState): boolean {
  return findPrevLiveWorktreeHistoryIndex(state) !== null
}

export function canGoForwardWorktreeHistory(state: AppState): boolean {
  return findNextLiveWorktreeHistoryIndex(state) !== null
}

export const createWorktreeNavHistorySlice: StateCreator<
  AppState,
  [],
  [],
  WorktreeNavHistorySlice
> = (set, get) => ({
  worktreeNavHistory: [],
  worktreeNavHistoryIndex: -1,
  isNavigatingHistory: false,

  recordWorktreeVisit: (worktreeId) => {
    set((s) => appendHistoryEntry(s, worktreeId))
  },

  recordViewVisit: (entry) => {
    set((s) => appendHistoryEntry(s, entry))
  },

  goBackWorktree: () => {
    navigateToIndex(get, set, 'back')
  },

  goForwardWorktree: () => {
    navigateToIndex(get, set, 'forward')
  }
})

function navigateToIndex(
  get: () => AppState,
  set: (partial: Partial<AppState>) => void,
  direction: 'back' | 'forward'
): void {
  const state = get()
  if (direction === 'back') {
    if (state.worktreeNavHistoryIndex <= 0) {
      return
    }
  } else {
    if (state.worktreeNavHistoryIndex >= state.worktreeNavHistory.length - 1) {
      return
    }
  }
  const targetIndex =
    direction === 'back'
      ? findPrevLiveWorktreeHistoryIndex(state)
      : findNextLiveWorktreeHistoryIndex(state)
  if (targetIndex === null) {
    return
  }
  const targetEntry = state.worktreeNavHistory[targetIndex]

  // Why: capture-and-restore (not force false) so re-entrant navigation doesn't clobber the flag.
  const prevNavigating = get().isNavigatingHistory
  set({ isNavigatingHistory: true } as Partial<AppState>)
  try {
    if (isViewEntry(targetEntry)) {
      if (!viewActivator) {
        // Why: warn (not a silent no-op) so a page-entry chord isn't a broken-looking no-op.
        console.warn(
          `go${direction === 'back' ? 'Back' : 'Forward'}Worktree: view activator not registered`
        )
        return
      }
      // Why: use setActiveView (not open*Page) so replay doesn't mutate previousViewBefore* or fire page-open side effects.
      viewActivator(targetEntry)
      set({ worktreeNavHistoryIndex: targetIndex } as Partial<AppState>)
    } else {
      if (!activator) {
        // Why: warn (not a silent no-op) so a missing activator is diagnosable.
        console.warn(
          `go${direction === 'back' ? 'Back' : 'Forward'}Worktree called before worktree activator was registered`
        )
        return
      }
      // Why: `false` is the activator's only failure signal — advance the index only on success.
      const result = activator(targetEntry)
      if (result !== false) {
        set({ worktreeNavHistoryIndex: targetIndex } as Partial<AppState>)
      }
    }
  } finally {
    set({ isNavigatingHistory: prevNavigating } as Partial<AppState>)
  }
}
