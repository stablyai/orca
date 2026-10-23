import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../shared/sidebar-inputs-switch'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { getFolderWorkspaceWorktreeHostId } from '../../../shared/folder-workspace-worktree'
import type { Repo } from '../../../shared/repo-types'
import type { SidebarFeedDomains } from '../../../shared/sidebar-list/sidebar-feed-domains'
import {
  buildPairedServerRows,
  type PairedServerWorkspaceRow
} from '../../../shared/sidebar-list/paired-server-rows'
import { buildWorkspaceRows, type WorkspaceRow } from '../../../shared/sidebar-list/workspace-rows'
import type { WorktreeLineage } from '../../../shared/worktree/lineage-types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getExecutionHostIdFromWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import {
  onDesktopSidebarFeedInstalled,
  refreshDesktopSidebarFeed,
  type DesktopSidebarFeed
} from './desktop-sidebar-feed'

// The row fields a sidebar drag, pin or rename writes, named alike in metadata and main's rows.
const ROW_WRITE_FIELDS = [
  'manualOrder',
  'workspaceStatus',
  'isPinned',
  'isArchived',
  'isUnread',
  'displayName'
] as const satisfies readonly (keyof WorktreeMeta &
  keyof WorkspaceRow &
  keyof PairedServerWorkspaceRow)[]

type RowWriteField = (typeof ROW_WRITE_FIELDS)[number]
type RowWriteValues = Partial<Pick<WorktreeMeta, RowWriteField>>

// Bounds what main never shows (a paired server that dropped a write); main's value wins after.
const PENDING_LIMIT_MS = 10_000

type PendingRow = {
  /** The operation it came from; answering and expiry find it by this, whatever it was trimmed to. */
  opId: number
  worktreeId: string
  /** Null: a local row whose metadata names no host, matched on every host. */
  hostId: ExecutionHostId | null
  /** The feed read sent once main answered; null while the operation runs. */
  answeredBy: number | null
}

type PendingRowWrite = PendingRow & { values: RowWriteValues }

type CreatedWorkspace = { worktree: Worktree } | { folderWorkspace: FolderWorkspace }

/** The window's own sidebar operations main's feed does not show yet. */
export type SidebarPendingLayer = {
  writes: readonly PendingRowWrite[]
  created: readonly (PendingRow & { workspace: CreatedWorkspace })[]
}

export type SidebarRowWrite = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
  executionHostId?: ExecutionHostId
}

let layer: SidebarPendingLayer = { writes: [], created: [] }
let lastOpId = 0
const listeners = new Set<() => void>()
let detachSettlement: (() => void) | null = null

function publish(next: SidebarPendingLayer): void {
  layer = next
  listeners.forEach((listener) => listener())
}

function targets(entry: PendingRow, id: string, hostId: ExecutionHostId | null): boolean {
  return entry.worktreeId === id && (entry.hostId === null || entry.hostId === hostId)
}

function rowHostId(row: WorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(row.hostId)?.id ?? null
}

function serverRowHostId(row: PairedServerWorkspaceRow): ExecutionHostId | null {
  return parseExecutionHostId(getExecutionHostIdFromWorktreeHostIdentity(row.key))?.id ?? null
}

function answered(entry: PendingRow, installed: DesktopSidebarFeed): boolean {
  return entry.answeredBy !== null && installed.readId >= entry.answeredBy
}

/**
 * Main answers a write to its own rows only after applying it, so a read sent after the answer
 * shows it. A paired server's row reaches main by the server's own change event, later, so that
 * write holds until main's row echoes it.
 */
function writeShown(write: PendingRowWrite, installed: DesktopSidebarFeed): boolean {
  return (
    answered(write, installed) &&
    [...installed.domains.pairedServerRows.values()].every(
      (row) =>
        !targets(write, row.worktreeId, serverRowHostId(row)) ||
        ROW_WRITE_FIELDS.every(
          (field) => !(field in write.values) || row[field] === write.values[field]
        )
    )
  )
}

/** Main announces a new workspace after it answers the create, so it holds until main lists it. */
function createdShown(created: PendingRow, installed: DesktopSidebarFeed): boolean {
  const { workspaces, pairedServerRows } = installed.domains
  return (
    answered(created, installed) &&
    ([...workspaces.values()].some((row) => targets(created, row.id, rowHostId(row))) ||
      [...pairedServerRows.values()].some((row) =>
        targets(created, row.worktreeId, serverRowHostId(row))
      ))
  )
}

function settle(installed: DesktopSidebarFeed): void {
  const writes = layer.writes.filter((write) => !writeShown(write, installed))
  const created = layer.created.filter((entry) => !createdShown(entry, installed))
  if (writes.length !== layer.writes.length || created.length !== layer.created.length) {
    publish({ writes, created })
  }
}

/** Marks operations answered and reads main again; drops whichever main still has not shown later. */
function answer<Entry extends PendingRow>(
  opIds: ReadonlySet<number>,
  pick: (pending: SidebarPendingLayer) => readonly Entry[],
  put: (pending: SidebarPendingLayer, next: readonly Entry[]) => SidebarPendingLayer
): void {
  const answeredBy = refreshDesktopSidebarFeed()
  const ours = (entry: Entry): boolean => opIds.has(entry.opId)
  publish(
    put(
      layer,
      pick(layer).map((entry) => (ours(entry) ? { ...entry, answeredBy } : entry))
    )
  )
  setTimeout(() => {
    if (pick(layer).some(ours)) {
      console.warn('[sidebar] main never showed a pending sidebar change; showing main’s value')
      publish(
        put(
          layer,
          pick(layer).filter((entry) => !ours(entry))
        )
      )
    }
  }, PENDING_LIMIT_MS)
}

function startSettling(): void {
  detachSettlement ??= onDesktopSidebarFeedInstalled(settle)
}

function copyField<Field extends RowWriteField>(
  to: RowWriteValues,
  from: RowWriteValues,
  field: Field
): void {
  to[field] = from[field]
}

function pickRowFields(
  from: RowWriteValues,
  keep: (field: RowWriteField) => boolean
): RowWriteValues | null {
  const values: RowWriteValues = {}
  const fields = ROW_WRITE_FIELDS.filter((field) => field in from && keep(field))
  fields.forEach((field) => copyField(values, from, field))
  return fields.length > 0 ? values : null
}

/** Earlier writes give up the fields a newer write to the same row sets, so the newest shows. */
function supersede(
  writes: readonly PendingRowWrite[],
  newer: readonly PendingRowWrite[]
): PendingRowWrite[] {
  return writes.flatMap((write) => {
    const covered = newer.filter(
      (next) => next.worktreeId === write.worktreeId && next.hostId === write.hostId
    )
    if (covered.length === 0) {
      return [write]
    }
    const values = pickRowFields(write.values, (field) =>
      covered.every((next) => !(field in next.values))
    )
    return values ? [{ ...write, values }] : []
  })
}

/**
 * Switch point. Shows the window's own row writes before main's feed has caught up: each is laid
 * over main's rows from its start until main shows it, so main's value wins afterwards whether
 * main took the write or not.
 */
export function withPendingSidebarRowWrites<T>(
  readWrites: () => readonly SidebarRowWrite[],
  operation: () => Promise<T>
): Promise<T> {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return operation()
  }
  const added = readWrites().flatMap((write): PendingRowWrite[] => {
    const values = pickRowFields(write.updates, () => true)
    const hostId = parseExecutionHostId(write.executionHostId)?.id ?? null
    return values
      ? [{ opId: ++lastOpId, worktreeId: write.worktreeId, hostId, values, answeredBy: null }]
      : []
  })
  if (added.length === 0) {
    return operation()
  }
  startSettling()
  publish({ ...layer, writes: [...supersede(layer.writes, added), ...added] })
  // A write that never answers stays shown, as the store keeps its own optimistic value.
  const running = operation()
  const opIds = new Set(added.map((write) => write.opId))
  const settleAdded = (): void =>
    answer(
      opIds,
      (pending) => pending.writes,
      (pending, next) => ({ ...pending, writes: next })
    )
  void running.then(settleAdded, settleAdded)
  return running
}

/** Switch point. Lists a workspace the window just created until main's feed lists it too. */
export function holdCreatedSidebarWorkspace(workspace: CreatedWorkspace): void {
  if (!ORCA_SIDEBAR_INPUTS_IS_MAIN) {
    return
  }
  const [worktreeId, rawHostId] =
    'worktree' in workspace
      ? [workspace.worktree.id, workspace.worktree.hostId]
      : [
          folderWorkspaceKey(workspace.folderWorkspace.id),
          getFolderWorkspaceWorktreeHostId(workspace.folderWorkspace)
        ]
  const host = parseExecutionHostId(rawHostId)
  const entry = {
    opId: ++lastOpId,
    worktreeId,
    hostId: host?.id ?? null,
    workspace,
    answeredBy: null
  }
  startSettling()
  publish({ ...layer, created: [...layer.created, entry] })
  answer(
    new Set([entry.opId]),
    (pending) => pending.created,
    (pending, next) => ({ ...pending, created: next })
  )
}

function patch<Row extends Partial<Pick<WorkspaceRow, RowWriteField>>>(
  row: Row,
  id: string,
  hostId: ExecutionHostId | null,
  writes: readonly PendingRowWrite[]
): Row {
  let patched = row
  for (const write of writes) {
    if (targets(write, id, hostId)) {
      patched = { ...patched, ...write.values }
    }
  }
  return patched
}

function withMissing<Key, Row>(
  rows: ReadonlyMap<Key, Row>,
  added: ReadonlyMap<Key, Row>
): Map<Key, Row> {
  const merged = new Map(rows)
  for (const [key, row] of added) {
    if (!merged.has(key)) {
      merged.set(key, row)
    }
  }
  return merged
}

/** Main's inputs with the window's pending operations over them; the same object when none. */
export function overlaySidebarPendingLayer(
  domains: SidebarFeedDomains,
  pending: SidebarPendingLayer,
  catalog: { repos: readonly Repo[]; lineageById: Readonly<Record<string, WorktreeLineage>> }
): SidebarFeedDomains {
  const { writes, created } = pending
  if (writes.length === 0 && created.length === 0) {
    return domains
  }
  const createdCatalog = {
    ...catalog,
    worktrees: created.flatMap(({ workspace }) =>
      'worktree' in workspace ? [workspace.worktree] : []
    ),
    folderWorkspaces: created.flatMap(({ workspace }) =>
      'folderWorkspace' in workspace ? [workspace.folderWorkspace] : []
    )
  }
  const workspaces = withMissing(domains.workspaces, buildWorkspaceRows(createdCatalog))
  // Main lists a paired server's new row only once the server's own list reaches it.
  const pairedServerRows = withMissing(
    domains.pairedServerRows,
    buildPairedServerRows(createdCatalog)
  )
  const touched = new Set(writes.map((write) => write.worktreeId))
  for (const [identity, row] of workspaces) {
    if (touched.has(row.id)) {
      workspaces.set(identity, patch(row, row.id, rowHostId(row), writes))
    }
  }
  for (const [key, row] of pairedServerRows) {
    if (touched.has(row.worktreeId)) {
      pairedServerRows.set(key, patch(row, row.worktreeId, serverRowHostId(row), writes))
    }
  }
  return { ...domains, workspaces, pairedServerRows }
}

export function subscribeSidebarPendingLayer(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function readSidebarPendingLayer(): SidebarPendingLayer {
  return layer
}
