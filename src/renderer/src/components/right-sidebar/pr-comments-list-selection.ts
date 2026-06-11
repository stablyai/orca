import { useCallback, useMemo, useState } from 'react'
import {
  getPRCommentGroupId,
  getPRCommentGroupRoot,
  groupPRComments,
  type PRCommentGroup
} from '@/lib/pr-comment-groups'
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

type PRCommentsListSelectionState = {
  contextKey: string | undefined
  isSelectingForAI: boolean
  selectedGroupIds: Set<string>
}

const EMPTY_SELECTED_GROUP_IDS = new Set<string>()

export function usePRCommentsListSelection(
  comments: PRComment[],
  selectionContextKey: string | undefined
): PRCommentsListSelection {
  const [selectionState, setSelectionState] = useState<PRCommentsListSelectionState>(() => ({
    contextKey: selectionContextKey,
    isSelectingForAI: false,
    selectedGroupIds: new Set()
  }))

  // Why: selectable groups come from the unfiltered list so switching the
  // audience filter doesn't silently drop already-selected comments.
  const canonicalGroups = useMemo(() => groupPRComments(comments), [comments])
  const selectableGroups = useMemo(
    () => canonicalGroups.filter((group) => getPRCommentGroupRoot(group).isResolved !== true),
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
      setSelectionState({
        contextKey: selectionContextKey,
        isSelectingForAI: true,
        selectedGroupIds: new Set([groupId])
      })
    },
    [selectableGroupsById, selectionContextKey]
  )

  const clearSelection = useCallback((): void => {
    setSelectionState({
      contextKey: selectionContextKey,
      isSelectingForAI: false,
      selectedGroupIds: new Set()
    })
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
        return {
          contextKey: selectionContextKey,
          isSelectingForAI: true,
          selectedGroupIds: next
        }
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
