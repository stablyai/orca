import { isWorktreePaletteQueryTooLarge } from './worktree-palette-query-bounds'

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
  // Why no project gate: the composer can add the first project inline, so
  // creation stays offered with zero projects.
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

export const WORKTREE_PALETTE_SELECTION_MOVE_KEYS: ReadonlySet<string> = new Set([
  'ArrowDown',
  'ArrowUp',
  'Home',
  'End',
  'PageDown',
  'PageUp'
])

type WorktreePaletteSelectionCandidateEntry = {
  id: string
  type: string
}

// Why every rendered CommandItem type belongs here: an id missing from this list fails the
// `includes` check in getNextWorktreePaletteSelection, so arrowing onto that row snaps the
// highlight back to the top — making the whole section mouse-only.
const SELECTABLE_ENTRY_TYPES = [
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
  // Why: keyboard focus should mirror rendered order, including synthetic
  // action rows, while skipping only section headers.
  // Why renderKeys wins: rows render under de-duplicated keys, so naming the bare
  // id here would leave a duplicate row absent from the list the `includes` check
  // above consults — arrowing onto it would snap the highlight back to the top.
  return entries
    .map((entry, index) => ({ entry, id: renderKeys[index] ?? entry.id }))
    .filter(({ entry }) => isSelectableWorktreePaletteEntry(entry))
    .map(({ id }) => id)
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
  const defaultSelectableId =
    (autoSelectCreateAction
      ? selectableItemIds[0]
      : selectableItemIds.find((id) => id !== CREATE_WORKTREE_ITEM_ID)) ?? null
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
