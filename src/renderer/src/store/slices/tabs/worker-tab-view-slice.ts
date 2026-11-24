import { windowGroupSelectionPatch } from '@/store/workspace-layout/workspace-layout-cache'
import { pruneWorkerTabViewsOnTabRemoval } from './worker-tab-view-pruning'
import { saveWorkerTabWindowChoices } from '@/components/tab-bar/worker-tab-window-choices'
import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import type { WorkerTabStripChoice } from '../../../../../shared/workspace-layout/tab-groups/worker-tab-visibility'

/** Per-window view state for worker tabs; the host-owned stamp lives on the tab itself. */
export type WorkerTabViewSlice = {
  /** One preview-style worker tab per pane; never persisted, so a restart folds it again. */
  workerTabPeekByGroupId: Record<string, string>
  /** Deliberate Keep / Hide per worktree; absent means automatic. Persisted for this window. */
  workerTabStripChoiceByWorktree: Record<string, Record<string, WorkerTabStripChoice>>
  /** Workers shown because the sidebar could not lead back to them; sticky until hidden. */
  workerTabFailOpenShown: Record<string, true>
  /** Bumped when a fold grace window ends, so memoized fold sets re-evaluate. */
  workerTabGraceEpoch: number
  peekWorkerTab: (groupId: string, tabId: string) => void
  clearWorkerTabPeek: (groupId: string, tabId?: string) => void
  setWorkerTabStripChoice: (
    worktreeId: string,
    tabId: string,
    choice: WorkerTabStripChoice | null
  ) => void
  hydrateWorkerTabStripChoices: (
    choices: Record<string, Record<string, WorkerTabStripChoice>> | undefined
  ) => void
  markWorkerTabFailOpenShown: (tabIds: readonly string[]) => void
  bumpWorkerTabGraceEpoch: () => void
  /** Leave a pane on its landing: no active tab, nothing reselected, folded workers still running. */
  clearGroupActiveTab: (worktreeId: string, groupId: string) => void
}

function withChoice(
  current: Record<string, Record<string, WorkerTabStripChoice>>,
  worktreeId: string,
  tabId: string,
  choice: WorkerTabStripChoice | null
): Record<string, Record<string, WorkerTabStripChoice>> | null {
  const existing = current[worktreeId]
  if ((existing?.[tabId] ?? null) === choice) {
    return null
  }
  const nextForWorktree = { ...existing }
  if (choice) {
    nextForWorktree[tabId] = choice
  } else {
    delete nextForWorktree[tabId]
  }
  const next = { ...current }
  if (Object.keys(nextForWorktree).length === 0) {
    delete next[worktreeId]
  } else {
    next[worktreeId] = nextForWorktree
  }
  return next
}

export const createWorkerTabViewSlice: StateCreator<AppState, [], [], WorkerTabViewSlice> = (
  set,
  get,
  api
) => {
  pruneWorkerTabViewsOnTabRemoval(api)
  return {
    workerTabPeekByGroupId: {},
    workerTabStripChoiceByWorktree: {},
    workerTabFailOpenShown: {},
    workerTabGraceEpoch: 0,
    peekWorkerTab: (groupId, tabId) => {
      if (get().workerTabPeekByGroupId[groupId] === tabId) {
        return
      }
      set((state) => ({
        workerTabPeekByGroupId: { ...state.workerTabPeekByGroupId, [groupId]: tabId }
      }))
    },
    clearWorkerTabPeek: (groupId, tabId) => {
      const current = get().workerTabPeekByGroupId[groupId]
      if (current === undefined || (tabId !== undefined && current !== tabId)) {
        return
      }
      set((state) => {
        const next = { ...state.workerTabPeekByGroupId }
        delete next[groupId]
        return { workerTabPeekByGroupId: next }
      })
    },
    setWorkerTabStripChoice: (worktreeId, tabId, choice) => {
      const next = withChoice(get().workerTabStripChoiceByWorktree, worktreeId, tabId, choice)
      if (!next) {
        return
      }
      // A deliberate Hide also ends a fail-open show; the user chose where the worker lives.
      const failOpen = get().workerTabFailOpenShown
      const clearFailOpen = choice === 'hidden' && failOpen[tabId]
      set({
        workerTabStripChoiceByWorktree: next,
        ...(clearFailOpen
          ? {
              workerTabFailOpenShown: Object.fromEntries(
                Object.entries(failOpen).filter(([id]) => id !== tabId)
              )
            }
          : {})
      })
      saveWorkerTabWindowChoices(next)
    },
    hydrateWorkerTabStripChoices: (choices) => {
      set({ workerTabStripChoiceByWorktree: choices ?? {} })
    },
    markWorkerTabFailOpenShown: (tabIds) => {
      const current = get().workerTabFailOpenShown
      const added = tabIds.filter((tabId) => !current[tabId])
      if (added.length === 0) {
        return
      }
      set({
        workerTabFailOpenShown: {
          ...current,
          ...Object.fromEntries(added.map((tabId) => [tabId, true as const]))
        }
      })
    },
    bumpWorkerTabGraceEpoch: () => {
      set((state) => ({ workerTabGraceEpoch: state.workerTabGraceEpoch + 1 }))
    },
    clearGroupActiveTab: (worktreeId, groupId) => {
      set((state) => windowGroupSelectionPatch(state, worktreeId, groupId, null))
    }
  }
}
