import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import {
  isPinnedWorktreeRow,
  type FolderWorkspaceItemRow,
  type WorktreeItemRow
} from '../listing/renderable-rows'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { getFolderWorkspaceRowNavigationKey } from '../../../../../../shared/sidebar-list/sections/row-builders'

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

// The clicked occurrence owns the primary active surface; other rendered copies stay secondary.
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

  // Revalidate during render so a hidden or switched-away occurrence cannot paint as primary or resurrect later.
  const [validatedFor, setValidatedFor] = useState({ rows, activeIdentity })
  if (validatedFor.rows !== rows || validatedFor.activeIdentity !== activeIdentity) {
    setValidatedFor({ rows, activeIdentity })
    const current = primaryActiveWorktreeRow
    const stillPrimary =
      current !== null &&
      current.worktreeIdentity === activeIdentity &&
      rows.some((row) => {
        const activatable = getActivatableRow(row)
        return (
          activatable?.identity === current.worktreeIdentity &&
          activatable.rowKey === current.rowKey
        )
      })
    if (current !== null && !stillPrimary) {
      setPrimaryActiveWorktreeRow(null)
    }
  }

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
