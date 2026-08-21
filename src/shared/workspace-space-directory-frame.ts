import type { WorkspaceSpaceItemKind } from './workspace-space-types'

type ScannableWorkspaceSpaceItemKind = Exclude<WorkspaceSpaceItemKind, 'other'>

export type WorkspaceSpaceEntryScan = {
  name: string
  path: string
  kind: ScannableWorkspaceSpaceItemKind
  sizeBytes: number
  skippedEntryCount: number
  children?: WorkspaceSpaceEntryScan[]
}

export type WorkspaceSpaceEntryIdentity = {
  kind: ScannableWorkspaceSpaceItemKind
  sizeBytes: number
}

export type ParentSlot<TEntry> = {
  frame: DirectoryFrame<TEntry>
  index: number
}

/**
 * One directory the walk has opened but not finished. `entries` is the admitted
 * listing; `childResults` is only allocated for the root, because callers read
 * top-level items and aggregate totals rather than the whole tree.
 */
export type DirectoryFrame<TEntry> = {
  result: WorkspaceSpaceEntryScan
  entries: readonly TEntry[]
  /** Budget charge held for `entries`, returned once the listing is dispatched. */
  retainedBytes: number
  retired: boolean
  nextIndex: number
  remainingChildren: number
  childResults?: (WorkspaceSpaceEntryScan | null | undefined)[]
  parentSlot?: ParentSlot<TEntry>
}

export type EntryJob<TEntry> = {
  frame: DirectoryFrame<TEntry>
  index: number
  entry: TEntry
  name: string
  path: string
}

export function createEntryScan(
  path: string,
  name: string,
  identity: WorkspaceSpaceEntryIdentity
): WorkspaceSpaceEntryScan {
  return {
    name,
    path,
    kind: identity.kind,
    sizeBytes: identity.sizeBytes,
    skippedEntryCount: 0
  }
}
