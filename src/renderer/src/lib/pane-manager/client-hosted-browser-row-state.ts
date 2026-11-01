import { useCallback, useSyncExternalStore } from 'react'
import type {
  ClientHostedBrowserRow,
  ClientHostedBrowserRowsEvent
} from '../../../../shared/client-hosted-browser-rows'

/** Host UI placeholders for pages rendered on paired clients own no page. Keep derived module state outside persisted tab/browser stores or restart/runtime projection would resurrect them as host-local tabs. */

export type ClientHostedBrowserRowSelection = {
  worktreeId: string
  browserPageId: string
  groupId: string
  // Which tab the group had active when the row was picked; the selection dies when that moves.
  groupActiveTabIdAtSelection: string | null
}

const EMPTY_ROWS: readonly ClientHostedBrowserRow[] = []

const rowsByWorktreeId = new Map<string, readonly ClientHostedBrowserRow[]>()
let selection: ClientHostedBrowserRowSelection | null = null

const snapshotListeners = new Set<() => void>()
let version = 0

function subscribe(listener: () => void): () => void {
  snapshotListeners.add(listener)
  return () => {
    snapshotListeners.delete(listener)
  }
}

function getSnapshot(): number {
  return version
}

function getServerSnapshot(): number {
  return 0
}

function getNoActiveRowServerSnapshot(): string | null {
  return null
}

function notifyChange(): void {
  version += 1
  for (const listener of snapshotListeners) {
    listener()
  }
}

function dropSelectionForMissingRow(): void {
  if (!selection) {
    return
  }
  const rows = rowsByWorktreeId.get(selection.worktreeId) ?? EMPTY_ROWS
  if (!rows.some((row) => row.browserPageId === selection?.browserPageId)) {
    selection = null
  }
}

export function applyClientHostedBrowserRows(event: ClientHostedBrowserRowsEvent): void {
  if (event.rows.length === 0) {
    rowsByWorktreeId.delete(event.worktreeId)
  } else {
    rowsByWorktreeId.set(event.worktreeId, event.rows)
  }
  dropSelectionForMissingRow()
  notifyChange()
}

export function hydrateClientHostedBrowserRows(
  events: readonly ClientHostedBrowserRowsEvent[]
): void {
  rowsByWorktreeId.clear()
  for (const event of events) {
    if (event.rows.length > 0) {
      rowsByWorktreeId.set(event.worktreeId, event.rows)
    }
  }
  dropSelectionForMissingRow()
  notifyChange()
}

export function getClientHostedBrowserRows(worktreeId: string): readonly ClientHostedBrowserRow[] {
  return rowsByWorktreeId.get(worktreeId) ?? EMPTY_ROWS
}

export function useClientHostedBrowserRows(worktreeId: string): readonly ClientHostedBrowserRow[] {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return getClientHostedBrowserRows(worktreeId)
}

export function selectClientHostedBrowserRow(next: ClientHostedBrowserRowSelection): void {
  selection = next
  notifyChange()
}

// Plain tab activation is a no-op here; avoid version bumps/rerenders across every strip.
export function clearClientHostedBrowserRowSelection(): void {
  if (!selection) {
    return
  }
  selection = null
  notifyChange()
}

export function getClientHostedBrowserRowSelection(): ClientHostedBrowserRowSelection | null {
  return selection
}

export function useClientHostedBrowserRowSelection(): ClientHostedBrowserRowSelection | null {
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return selection
}

/** Expire selection when the underlying group’s active tab changes, regardless of click/keyboard/palette source. */
export function isClientHostedBrowserRowSelectionLive(
  candidate: ClientHostedBrowserRowSelection | null,
  groups: readonly { id: string; activeTabId?: string | null }[]
): boolean {
  if (!candidate) {
    return false
  }
  const group = groups.find((entry) => entry.id === candidate.groupId)
  return (
    group !== undefined && (group.activeTabId ?? null) === candidate.groupActiveTabIdAtSelection
  )
}

export type ClientHostedBrowserRowStripScope = {
  worktreeId: string
  groupId: string
  groupActiveTabId: string | null
}

/** Share active-style ownership across real tabs and trailing placeholder rows so both cannot appear selected. */
export function resolveActiveClientHostedBrowserRowId(
  candidate: ClientHostedBrowserRowSelection | null,
  scope: ClientHostedBrowserRowStripScope
): string | null {
  if (!candidate || candidate.worktreeId !== scope.worktreeId) {
    return null
  }
  return isClientHostedBrowserRowSelectionLive(candidate, [
    { id: scope.groupId, activeTabId: scope.groupActiveTabId }
  ])
    ? candidate.browserPageId
    : null
}

export function useActiveClientHostedBrowserRowId(
  scope: ClientHostedBrowserRowStripScope
): string | null {
  const { worktreeId, groupId, groupActiveTabId } = scope
  // Subscribe to the derived active ID so title/loading pushes do not rerender unrelated strips.
  const getActiveRowId = useCallback(
    () =>
      resolveActiveClientHostedBrowserRowId(selection, { worktreeId, groupId, groupActiveTabId }),
    [groupActiveTabId, groupId, worktreeId]
  )
  return useSyncExternalStore(subscribe, getActiveRowId, getNoActiveRowServerSnapshot)
}
