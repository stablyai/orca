import { isWorktreePaletteQueryTooLarge } from '../../../shared/palette-match/worktree-palette-query-bounds'

export const CREATE_WORKTREE_ITEM_ID = '__create_worktree__'

export type WorktreePaletteCreateActionState = {
  createWorktreeName: string
  showCreateAction: boolean
}

export function getWorktreePaletteCreateActionState({
  query
}: {
  query: string
}): WorktreePaletteCreateActionState {
  const createWorktreeName = query.trim()
  if (isWorktreePaletteQueryTooLarge(createWorktreeName)) {
    return {
      createWorktreeName: '',
      showCreateAction: false
    }
  }
  // Composer can add the first project inline, so creation needs no existing project.
  return {
    createWorktreeName,
    showCreateAction: createWorktreeName.length > 0
  }
}

/**
 * cmdk auto-selects the first item once the controlled value is empty, so a
 * query that matches nothing would leave Create armed for Enter. Creation
 * therefore needs an explicit gesture — a recognized task URL is the one intent
 * allowed to arm itself.
 */
export function isWorktreePaletteCreateActivationAllowed(args: {
  hasTaskUrlIntent: boolean
  hasCreateName: boolean
  selectionMovedByUser: boolean
}): boolean {
  return args.hasTaskUrlIntent || args.hasCreateName || args.selectionMovedByUser
}

type WorktreePaletteSelectionCandidateEntry = {
  id: string
  type: string
}

// Include every rendered item type or keyboard navigation’s includes guard snaps its highlight to top, leaving mouse-only rows.
const SELECTABLE_ENTRY_TYPES = [
  'agent',
  'worktree',
  'create-worktree',
  'settings',
  'quick-action',
  'browser-page',
  'workspace-tab',
  'simulator-tab',
  'project-target',
  'hint'
] as const

type WorktreePaletteSelectableEntryType = (typeof SELECTABLE_ENTRY_TYPES)[number]

const SELECTABLE_ENTRY_TYPE_SET = new Set<string>(SELECTABLE_ENTRY_TYPES)

export function isSelectableWorktreePaletteEntry(
  entry: WorktreePaletteSelectionCandidateEntry
): entry is WorktreePaletteSelectionCandidateEntry & {
  type: WorktreePaletteSelectableEntryType
} {
  return SELECTABLE_ENTRY_TYPE_SET.has(entry.type)
}

export function getWorktreePaletteSelectionItemIds<
  T extends WorktreePaletteSelectionCandidateEntry
>(entries: readonly T[], renderKeys: readonly string[] = []): string[] {
  // Keyboard order must include synthetic actions and skip only headers.
  // Prefer deduplicated renderKeys; bare IDs omit duplicate rows and snap keyboard highlight to top.
  return entries
    .map((entry, index) => ({ entry, id: renderKeys[index] ?? entry.id }))
    .filter(({ entry }) => isSelectableWorktreePaletteEntry(entry))
    .map(({ id }) => id)
}

// Agent rows sit above Recent but never take the default, so "Cmd+J, Enter" still returns to the last session.
export const AGENT_PALETTE_ITEM_ID_PREFIX = 'agent:'

export function getDefaultWorktreePaletteSelectionId(
  selectableItemIds: readonly string[],
  autoSelectCreateAction = false
): string | null {
  const isCandidate = (id: string): boolean =>
    autoSelectCreateAction || id !== CREATE_WORKTREE_ITEM_ID
  return (
    selectableItemIds.find(
      (id) => isCandidate(id) && !id.startsWith(AGENT_PALETTE_ITEM_ID_PREFIX)
    ) ??
    selectableItemIds.find(isCandidate) ??
    null
  )
}

export function getNextWorktreePaletteSelection({
  currentSelectedItemId,
  queryChanged,
  selectableItemIds,
  showCreateAction,
  autoSelectCreateAction = false
}: {
  currentSelectedItemId: string
  queryChanged: boolean
  selectableItemIds: readonly string[]
  showCreateAction: boolean
  /**
   * Only a recognized task URL may land on Create by default. Free text must
   * never arm Enter to create, no matter how empty the result list is.
   */
  autoSelectCreateAction?: boolean
}): string {
  const defaultSelectableId = getDefaultWorktreePaletteSelectionId(
    selectableItemIds,
    autoSelectCreateAction
  )
  const fallbackId =
    defaultSelectableId ??
    (showCreateAction && autoSelectCreateAction ? CREATE_WORKTREE_ITEM_ID : '')

  if (queryChanged) {
    return fallbackId
  }

  if (currentSelectedItemId === CREATE_WORKTREE_ITEM_ID && showCreateAction) {
    return currentSelectedItemId
  }

  if (selectableItemIds.includes(currentSelectedItemId)) {
    return currentSelectedItemId
  }

  return fallbackId
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
