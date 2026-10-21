import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../../../shared/worktree/meta-types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { AppState } from '../../../../store/types'
import type { WorktreeMetaBatchUpdate } from '../../../../store/slices/worktree-helpers'
import { getAllWorktreesFromState } from '../../../../store/selectors'
import { getWorkspaceStatus } from '../../workspace-status'

/** The cards a drag picked up, by host: a twin on another host shares each card's id. */
export type DraggedWorktreeCopies = readonly Pick<Worktree, 'id' | 'hostId'>[]

export function draggedWorktreeCopiesOf(
  pressed: Worktree,
  selected: readonly Worktree[] | undefined,
  useSelection: boolean
): DraggedWorktreeCopies {
  return (useSelection && selected ? selected : [pressed]).map(({ id, hostId }) => ({ id, hostId }))
}

export function uniqueDraggedIds(copies: DraggedWorktreeCopies): string[] {
  return [...new Set(copies.map((copy) => copy.id))]
}

/** Which rows a drop may write for an id; empty means refuse, never guess a host. */
export type DropWriteRows = {
  /** Status is each card's own: the dragged copies (read fresh), else the id's only row. */
  status: (worktreeId: string) => readonly Worktree[]
  /** Manual order is ranked per id (the catalog drops a rank its copies disagree on), so every copy. */
  order: (worktreeId: string) => readonly Worktree[]
}

export function dropWriteRows(
  state: Pick<AppState, 'worktreesByRepo' | 'folderWorkspaces'>,
  copies: DraggedWorktreeCopies | undefined
): DropWriteRows {
  const rowsById = new Map<string, Worktree[]>()
  // Folder workspaces share the manual-order catalog, so a drop ranks them too.
  for (const row of [
    ...getAllWorktreesFromState(state),
    ...state.folderWorkspaces.map(folderWorkspaceToWorktree)
  ]) {
    rowsById.set(row.id, [...(rowsById.get(row.id) ?? []), row])
  }
  const dragged = new Set((copies ?? []).map(getWorktreeHostIdentity))
  const draggedIds = new Set((copies ?? []).map((copy) => copy.id))
  return {
    status: (worktreeId) => {
      const rows = rowsById.get(worktreeId) ?? []
      if (draggedIds.has(worktreeId)) {
        return rows.filter((row) => dragged.has(getWorktreeHostIdentity(row)))
      }
      return rows.length === 1 ? rows : []
    },
    order: (worktreeId) => rowsById.get(worktreeId) ?? []
  }
}

/** The one place a drop turns status and rank changes into per-row writes, each on its row's host. */
export function collectDropWrites(args: {
  rowsFor: DropWriteRows
  statusIds: readonly string[]
  status: WorkspaceStatus | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  orderUpdates: ReadonlyMap<string, { manualOrder: number }>
}): WorktreeMetaBatchUpdate[] {
  const writes = new Map<string, WorktreeMetaBatchUpdate>()
  const write = (row: Worktree, updates: Partial<WorktreeMeta>): void => {
    const key = getWorktreeHostIdentity(row)
    const entry = writes.get(key) ?? {
      worktreeId: row.id,
      updates: {},
      executionHostId: row.hostId ?? 'local'
    }
    entry.updates = { ...entry.updates, ...updates }
    writes.set(key, entry)
  }
  const { status } = args
  if (status !== null) {
    for (const worktreeId of args.statusIds) {
      for (const row of args.rowsFor.status(worktreeId)) {
        if (getWorkspaceStatus(row, args.workspaceStatuses) !== status) {
          write(row, { workspaceStatus: status })
        }
      }
    }
  }
  for (const [worktreeId, manualOrder] of args.orderUpdates) {
    for (const row of args.rowsFor.order(worktreeId)) {
      write(row, manualOrder)
    }
  }
  return [...writes.values()]
}
