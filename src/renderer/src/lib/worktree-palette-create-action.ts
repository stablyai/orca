export const CREATE_WORKTREE_ITEM_ID = '__create_worktree__'

export type WorktreePaletteCreateActionState = {
  createWorktreeName: string
  showCreateAction: boolean
  shouldDefaultToCreate: boolean
}

export function getWorktreePaletteCreateActionState({
  canCreateWorktree,
  query,
  selectableItemIds
}: {
  canCreateWorktree: boolean
  query: string
  selectableItemIds: readonly string[]
}): WorktreePaletteCreateActionState {
  const createWorktreeName = query.trim()
  const showCreateAction = canCreateWorktree && createWorktreeName.length > 0
  return {
    createWorktreeName,
    showCreateAction,
    shouldDefaultToCreate: showCreateAction && selectableItemIds.length === 0
  }
}

export function getNextWorktreePaletteSelection({
  currentSelectedItemId,
  queryChanged,
  selectableItemIds,
  showCreateAction
}: {
  currentSelectedItemId: string
  queryChanged: boolean
  selectableItemIds: readonly string[]
  showCreateAction: boolean
}): string {
  const firstSelectableId = selectableItemIds[0] ?? null

  if (queryChanged) {
    return firstSelectableId ?? (showCreateAction ? CREATE_WORKTREE_ITEM_ID : '')
  }

  if (currentSelectedItemId === CREATE_WORKTREE_ITEM_ID && showCreateAction) {
    return currentSelectedItemId
  }

  if (selectableItemIds.includes(currentSelectedItemId)) {
    return currentSelectedItemId
  }

  return firstSelectableId ?? (showCreateAction ? CREATE_WORKTREE_ITEM_ID : '')
}

export type WorktreePaletteRequestGuard = {
  start: () => number
  invalidate: () => void
  isCurrent: (token: number) => boolean
}

export function createWorktreePaletteRequestGuard(): WorktreePaletteRequestGuard {
  let currentToken = 0

  return {
    start: () => {
      currentToken += 1
      return currentToken
    },
    invalidate: () => {
      currentToken += 1
    },
    isCurrent: (token: number) => token === currentToken
  }
}
