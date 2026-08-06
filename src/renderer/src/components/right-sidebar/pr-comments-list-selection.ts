import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getPRCommentGroupId, groupPRComments, type PRCommentGroup } from '@/lib/pr-comment-groups'
import { isPRCommentGroupQueueableForAI } from '@/lib/pr-comment-action-state'
import type { PRComment } from '../../../../shared/types'

export type PRCommentsListSelection = {
  isSelectingForAI: boolean
  selectedGroupIds: ReadonlySet<string>
  selectableGroups: PRCommentGroup[]
  selectableGroupsById: ReadonlyMap<string, PRCommentGroup>
  selectedGroups: PRCommentGroup[]
  addGroupToSelection: (groupId: string) => void
  clearSelection: () => void
  toggleGroupSelection: (groupId: string, checked: boolean) => void
}

export type PRCommentsListSelectionClearRequest = {
  contextKey: string
  token: number
}

type PRCommentsListSelectionState = {
  contextKey: string | undefined
  isSelectingForAI: boolean
  selectedGroupIds: Set<string>
}

const EMPTY_SELECTED_GROUP_IDS = new Set<string>()
// Why: queued selections need to survive sidebar remounts, but old PR/MR
// contexts can disappear without another clear signal in a long renderer run.
export const MAX_PERSISTED_PR_COMMENTS_LIST_SELECTIONS = 1024
const persistedSelectionByContextKey = new Map<
  string,
  { isSelectingForAI: boolean; selectedGroupIds: Set<string> }
>()

function trimPersistedSelectionContexts(): void {
  while (persistedSelectionByContextKey.size > MAX_PERSISTED_PR_COMMENTS_LIST_SELECTIONS) {
    const oldestContextKey = persistedSelectionByContextKey.keys().next().value
    if (oldestContextKey === undefined) {
      break
    }
    persistedSelectionByContextKey.delete(oldestContextKey)
  }
}

function persistSelectionState(state: PRCommentsListSelectionState): void {
  if (!state.contextKey) {
    return
  }
  if (state.selectedGroupIds.size === 0) {
    persistedSelectionByContextKey.delete(state.contextKey)
    return
  }
  persistedSelectionByContextKey.delete(state.contextKey)
  persistedSelectionByContextKey.set(state.contextKey, {
    isSelectingForAI: state.isSelectingForAI,
    selectedGroupIds: new Set(state.selectedGroupIds)
  })
  trimPersistedSelectionContexts()
}

function refreshPersistedSelectionContext(contextKey: string | undefined): void {
  if (!contextKey) {
    return
  }
  const persisted = persistedSelectionByContextKey.get(contextKey)
  if (!persisted) {
    return
  }
  persistedSelectionByContextKey.delete(contextKey)
  persistedSelectionByContextKey.set(contextKey, persisted)
}

function readSelectionState(contextKey: string | undefined): PRCommentsListSelectionState {
  const persisted = contextKey ? persistedSelectionByContextKey.get(contextKey) : undefined
  return {
    contextKey,
    isSelectingForAI: persisted?.isSelectingForAI ?? false,
    selectedGroupIds: new Set(persisted?.selectedGroupIds ?? [])
  }
}

export function clearPRCommentsListSelection(contextKey: string | undefined): void {
  if (contextKey) {
    persistedSelectionByContextKey.delete(contextKey)
  }
}

export function clearPRCommentsListSelectionsForTests(): void {
  persistedSelectionByContextKey.clear()
}

export function getPRCommentsListSelectionCountForTests(): number {
  return persistedSelectionByContextKey.size
}

// Why: bound/LRU tests need to fill the cache without 1024 React mounts per case.
export function seedPRCommentsListSelectionForTests(
  contextKey: string,
  selectedGroupIds: Iterable<string>,
  isSelectingForAI = true
): void {
  persistSelectionState({
    contextKey,
    isSelectingForAI,
    selectedGroupIds: new Set(selectedGroupIds)
  })
}

export function usePRCommentsListSelection(
  comments: PRComment[],
  selectionContextKey: string | undefined,
  clearRequest?: PRCommentsListSelectionClearRequest | null
): PRCommentsListSelection {
  const lastClearRequestTokenRef = useRef<number | null>(null)
  const [renderedSelectionState, setRenderedSelectionState] =
    useState<PRCommentsListSelectionState>(() => readSelectionState(selectionContextKey))
  const selectionState =
    renderedSelectionState.contextKey === selectionContextKey
      ? renderedSelectionState
      : readSelectionState(selectionContextKey)
  const commitSelectionState = useCallback((next: PRCommentsListSelectionState): void => {
    persistSelectionState(next)
    setRenderedSelectionState(next)
  }, [])

  useEffect(() => {
    // Why: only a committed context may affect LRU order; render can be
    // abandoned or replayed by Strict Mode/Suspense.
    refreshPersistedSelectionContext(selectionContextKey)
  }, [selectionContextKey])

  useEffect(() => {
    if (
      !clearRequest ||
      clearRequest.contextKey !== selectionContextKey ||
      clearRequest.token === lastClearRequestTokenRef.current
    ) {
      return
    }
    lastClearRequestTokenRef.current = clearRequest.token
    const next = {
      contextKey: selectionContextKey,
      isSelectingForAI: false,
      selectedGroupIds: new Set<string>()
    }
    commitSelectionState(next)
  }, [clearRequest, commitSelectionState, selectionContextKey])

  // Why: selectable groups come from the unfiltered list so switching the
  // audience filter doesn't silently drop already-selected comments.
  const canonicalGroups = useMemo(() => groupPRComments(comments), [comments])
  const selectableGroups = useMemo(
    () => canonicalGroups.filter(isPRCommentGroupQueueableForAI),
    [canonicalGroups]
  )
  const selectableGroupsById = useMemo(() => {
    const map = new Map<string, PRCommentGroup>()
    for (const group of selectableGroups) {
      map.set(getPRCommentGroupId(group), group)
    }
    return map
  }, [selectableGroups])
  const isCurrentSelectionContext = selectionState.contextKey === selectionContextKey
  const candidateSelectedGroupIds = isCurrentSelectionContext
    ? selectionState.selectedGroupIds
    : EMPTY_SELECTED_GROUP_IDS
  const selectedGroupIds = useMemo(() => {
    let pruned = false
    const next = new Set<string>()
    for (const groupId of candidateSelectedGroupIds) {
      if (selectableGroupsById.has(groupId)) {
        next.add(groupId)
      } else {
        pruned = true
      }
    }
    return pruned ? next : candidateSelectedGroupIds
  }, [candidateSelectedGroupIds, selectableGroupsById])

  useEffect(() => {
    if (
      comments.length === 0 ||
      !isCurrentSelectionContext ||
      selectedGroupIds === candidateSelectedGroupIds
    ) {
      return
    }
    const next = {
      contextKey: selectionContextKey,
      isSelectingForAI: selectionState.isSelectingForAI,
      selectedGroupIds: new Set(selectedGroupIds)
    }
    commitSelectionState(next)
  }, [
    candidateSelectedGroupIds,
    commitSelectionState,
    comments.length,
    isCurrentSelectionContext,
    selectedGroupIds,
    selectionContextKey,
    selectionState.isSelectingForAI
  ])

  const isSelectingForAI =
    isCurrentSelectionContext && selectionState.isSelectingForAI && selectableGroupsById.size > 0
  const selectedGroups = useMemo(
    () =>
      [...selectedGroupIds]
        .map((groupId) => selectableGroupsById.get(groupId))
        .filter((group): group is PRCommentGroup => group !== undefined),
    [selectableGroupsById, selectedGroupIds]
  )

  const addGroupToSelection = useCallback(
    (groupId: string): void => {
      if (!selectableGroupsById.has(groupId)) {
        return
      }
      const next = {
        contextKey: selectionContextKey,
        isSelectingForAI: true,
        selectedGroupIds: new Set([groupId])
      }
      commitSelectionState(next)
    },
    [commitSelectionState, selectableGroupsById, selectionContextKey]
  )

  const clearSelection = useCallback((): void => {
    const next = {
      contextKey: selectionContextKey,
      isSelectingForAI: false,
      selectedGroupIds: new Set<string>()
    }
    commitSelectionState(next)
  }, [commitSelectionState, selectionContextKey])

  const toggleGroupSelection = useCallback(
    (groupId: string, checked: boolean): void => {
      if (!selectableGroupsById.has(groupId)) {
        return
      }
      const current = readSelectionState(selectionContextKey)
      const base =
        current.contextKey === selectionContextKey
          ? current.selectedGroupIds
          : EMPTY_SELECTED_GROUP_IDS
      const next = new Set([...base].filter((id) => selectableGroupsById.has(id)))
      if (checked) {
        next.add(groupId)
      } else {
        next.delete(groupId)
      }
      commitSelectionState({
        contextKey: selectionContextKey,
        isSelectingForAI: true,
        selectedGroupIds: next
      })
    },
    [commitSelectionState, selectableGroupsById, selectionContextKey]
  )

  return {
    isSelectingForAI,
    selectedGroupIds,
    selectableGroups,
    selectableGroupsById,
    selectedGroups,
    addGroupToSelection,
    clearSelection,
    toggleGroupSelection
  }
}
