import type { WorkspaceSortBy } from '../../../../shared/workspace-view/workspace-row-sort'

/** What the mounted list last committed, for the shadow check against main's temporal owner. */
export type WindowSidebarTemporalReadout = {
  sessionId: string
  sortBy: WorkspaceSortBy
  sortedIds: readonly string[]
  /** Undefined while sleeping workspaces are shown. */
  retainedIds: ReadonlySet<string> | undefined
}

let readout: WindowSidebarTemporalReadout | null = null

export function recordWindowSortOrder(
  sessionId: string,
  sortBy: WorkspaceSortBy,
  sortedIds: readonly string[]
): void {
  readout = { sessionId, sortBy, sortedIds, retainedIds: readout?.retainedIds }
}

export function recordWindowSleepingRetention(retainedIds: ReadonlySet<string> | undefined): void {
  if (readout) {
    readout = { ...readout, retainedIds }
  }
}

/** The list unmounted; nothing is compared until the next one begins. */
export function clearWindowSidebarTemporalReadout(sessionId: string): void {
  if (readout?.sessionId === sessionId) {
    readout = null
  }
}

export function readWindowSidebarTemporal(): WindowSidebarTemporalReadout | null {
  return readout
}
