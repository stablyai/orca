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
const persistedSelectionByContextKey = new Map<
  string,
  { isSelectingForAI: boolean; selectedGroupIds: Set<string> }
>()

function persistSelectionState(state: PRCommentsListSelectionState): void {
  if (!state.contextKey) {
    return
  }
  if (!state.isSelectingForAI && state.selectedGroupIds.size === 0) {
    persistedSelectionByContextKey.delete(state.contextKey)
    return
  }
  persistedSelectionByContextKey.set(state.contextKey, {
    isSelectingForAI: state.isSelectingForAI,
    selectedGroupIds: new Set(state.selectedGroupIds)
  })
}

function createSelectionState(contextKey: string | undefined): PRCommentsListSelectionState {
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

export function usePRCommentsListSelection(
  comments: PRComment[],
  selectionContextKey: string | undefined,
  clearRequest?: PRCommentsListSelectionClearRequest | null
): PRCommentsListSelection {
  const lastClearRequestTokenRef = useRef<number | null>(clearRequest?.token ?? null)
  const [selectionState, setSelectionState] = useState<PRCommentsListSelectionState>(() =>
    createSelectionState(selectionContextKey)
  )

  useEffect(() => {
    setSelectionState((prev) =>
      prev.contextKey === selectionContextKey ? prev : createSelectionState(selectionContextKey)
    )
  }, [selectionContextKey])

  useEffect(() => {
    if (!clearRequest || clearRequest.token === lastClearRequestTokenRef.current) {
      return
    }
    lastClearRequestTokenRef.current = clearRequest.token
    if (clearRequest.contextKey !== selectionContextKey) {
      return
    }
    const next = {
      contextKey: selectionContextKey,
      isSelectingForAI: false,
      selectedGroupIds: new Set<string>()
    }
    persistSelectionState(next)
    setSelectionState(next)
  }, [clearRequest, selectionContextKey])

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
    persistSelectionState(next)
    setSelectionState(next)
  }, [
    candidateSelectedGroupIds,
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
      persistSelectionState(next)
      setSelectionState(next)
    },
    [selectableGroupsById, selectionContextKey]
  )

  const clearSelection = useCallback((): void => {
    const next = {
      contextKey: selectionContextKey,
      isSelectingForAI: false,
      selectedGroupIds: new Set<string>()
    }
    persistSelectionState(next)
    setSelectionState(next)
  }, [selectionContextKey])

  const toggleGroupSelection = useCallback(
    (groupId: string, checked: boolean): void => {
      if (!selectableGroupsById.has(groupId)) {
        return
      }
      setSelectionState((prev) => {
        const base =
          prev.contextKey === selectionContextKey ? prev.selectedGroupIds : EMPTY_SELECTED_GROUP_IDS
        const next = new Set([...base].filter((id) => selectableGroupsById.has(id)))
        if (checked) {
          next.add(groupId)
        } else {
          next.delete(groupId)
        }
        const nextState = {
          contextKey: selectionContextKey,
          isSelectingForAI: true,
          selectedGroupIds: next
        }
        persistSelectionState(nextState)
        return nextState
      })
    },
    [selectableGroupsById, selectionContextKey]
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
