import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../WorktreeCard'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import {
  isPinnedWorktreeRow,
  type FolderWorkspaceItemRow,
  type WorktreeItemRow
} from '../listing/renderable-rows'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { getFolderWorkspaceRowNavigationKey } from '../grouping/row-builders'

type ActivatableRow = WorktreeItemRow | FolderWorkspaceItemRow

// Folder rows repeat across tag sections too, so they take part in primary/secondary styling.
function getActivatableRow(
  row: HostSectionRow
): { identity: string; worktreeId: string; rowKey: string } | null {
  if (row.type === 'item') {
    return {
      identity: composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id),
      worktreeId: row.worktree.id,
      rowKey: row.rowKey
    }
  }
  if (row.type === 'folder-workspace') {
    const worktree = folderWorkspaceToWorktree(row.folderWorkspace)
    return {
      identity: composeWorktreeHostIdentity(worktree.hostId, worktree.id),
      worktreeId: worktree.id,
      rowKey: getFolderWorkspaceRowNavigationKey(row)
    }
  }
  return null
}

// A worktree can render in more than one section; the row the user actually clicked owns
// the primary active surface so its duplicates stay visually secondary.
export function usePrimaryActiveWorktreeRow(args: {
  rows: HostSectionRow[]
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  pinnedDisplayPolicy: PinnedWorktreeDisplayPolicy
  onImmediateWorktreeActivate: (worktreeId: string, rowKey: string | undefined) => void
}) {
  const {
    rows,
    activeWorktreeId,
    activeWorkspaceExecutionHostId,
    pinnedDisplayPolicy,
    onImmediateWorktreeActivate
  } = args
  const activeIdentity = activeWorktreeId
    ? composeWorktreeHostIdentity(activeWorkspaceExecutionHostId ?? undefined, activeWorktreeId)
    : null
  const rowsRef = useRef(rows)
  useLayoutEffect(() => {
    rowsRef.current = rows
  }, [rows])
  const [primaryActiveWorktreeRow, setPrimaryActiveWorktreeRow] = useState<{
    worktreeIdentity: string
    rowKey: string
  } | null>(null)

  useLayoutEffect(() => {
    if (activeWorktreeId === null) {
      setPrimaryActiveWorktreeRow(null)
      return
    }
    setPrimaryActiveWorktreeRow((current) => {
      if (current === null || current.worktreeIdentity !== activeIdentity) {
        return null
      }
      const rowStillVisible = rows.some((row) => {
        const activatable = getActivatableRow(row)
        return (
          activatable?.identity === current.worktreeIdentity &&
          activatable.rowKey === current.rowKey
        )
      })
      return rowStillVisible ? current : null
    })
  }, [activeIdentity, activeWorktreeId, rows])

  const getActiveSurfaceVariant = useCallback(
    (row: ActivatableRow): ActiveSurfaceVariant => {
      const activatable = getActivatableRow(row)
      if (activatable && primaryActiveWorktreeRow?.worktreeIdentity === activatable.identity) {
        return primaryActiveWorktreeRow.rowKey === activatable.rowKey ? 'primary' : 'secondary'
      }
      if (
        row.type === 'item' &&
        pinnedDisplayPolicy === 'duplicate-in-groups' &&
        activeWorktreeId === row.worktree.id &&
        isPinnedWorktreeRow(row)
      ) {
        return 'secondary'
      }
      return 'primary'
    },
    [activeWorktreeId, pinnedDisplayPolicy, primaryActiveWorktreeRow]
  )

  const handleImmediateWorktreeRowActivate = useCallback(
    (worktreeId: string, rowKey: string | undefined): void => {
      const activatable = rowsRef.current
        .map(getActivatableRow)
        .find((candidate) => candidate?.worktreeId === worktreeId && candidate.rowKey === rowKey)
      setPrimaryActiveWorktreeRow(
        rowKey && activatable ? { worktreeIdentity: activatable.identity, rowKey } : null
      )
      onImmediateWorktreeActivate(worktreeId, rowKey)
    },
    [onImmediateWorktreeActivate]
  )

  return {
    primaryActiveWorktreeRow,
    getActiveSurfaceVariant,
    handleImmediateWorktreeRowActivate
  }
}
