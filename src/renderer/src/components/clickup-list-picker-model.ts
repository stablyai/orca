import type { ClickUpList } from '../../../shared/clickup-types'
import { isClickUpSprintList, type ClickUpSprint } from './clickup-sprints'
import type { ClickUpSprintSelection } from './clickup-task-view-preferences'

export type ClickUpPickerListGroup = {
  // '' holds Lists that sit directly in the Space.
  folderId: string
  folderName: string | null
  lists: ClickUpList[]
}

// Every word must appear in the name (or its Folder), so "cust feed" finds
// "Customer Feedback" only when both words match.
export function matchesClickUpPickerQuery(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => haystack.includes(word))
}

export function filterClickUpPickerSprints(
  sprints: readonly ClickUpSprint[],
  query: string
): ClickUpSprint[] {
  return sprints.filter((sprint) => matchesClickUpPickerQuery(sprint.name, query))
}

// Non-sprint Lists grouped by Folder in hierarchy order, Folderless Lists last.
export function groupClickUpPickerLists(
  lists: readonly ClickUpList[],
  query: string
): ClickUpPickerListGroup[] {
  const groups = new Map<string, ClickUpPickerListGroup>()
  for (const list of lists) {
    if (isClickUpSprintList(list)) {
      continue
    }
    const folderName = list.folder?.name ?? null
    if (!matchesClickUpPickerQuery(`${folderName ?? ''} ${list.name}`, query)) {
      continue
    }
    const folderId = list.folder?.id ?? ''
    const group = groups.get(folderId) ?? { folderId, folderName, lists: [] }
    group.lists.push(list)
    groups.set(folderId, group)
  }
  const ordered = [...groups.values()]
  return [...ordered.filter((group) => group.folderId), ...ordered.filter((g) => !g.folderId)]
}

// The List id to send as list_ids[], or null for no List narrowing. A saved
// List that left the Space falls back to no narrowing rather than an empty page.
export function resolveClickUpListSelection(
  selection: ClickUpSprintSelection,
  lists: readonly ClickUpList[],
  currentSprint: ClickUpSprint | null
): string | null {
  if (selection === 'all') {
    return null
  }
  if (selection === 'current') {
    return currentSprint?.listId ?? null
  }
  return lists.some((list) => list.id === selection.listId) ? selection.listId : null
}

export function clickUpSelectedListName(
  selection: ClickUpSprintSelection,
  lists: readonly ClickUpList[]
): string | null {
  return typeof selection === 'string'
    ? null
    : (lists.find((list) => list.id === selection.listId)?.name ?? null)
}
