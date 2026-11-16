import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getWorkspaceItemRowKey,
  getWorkspaceItemRowWorktree,
  isPinnedWorktreeRow,
  isWorkspaceItemRow,
  type WorkspaceItemRow
} from '../listing/renderable-rows'

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
      rows.some(
        (row) =>
          isWorkspaceItemRow(row) &&
          getWorktreeHostIdentity(getWorkspaceItemRowWorktree(row)) === current.worktreeIdentity &&
          getWorkspaceItemRowKey(row) === current.rowKey
      )
    if (current !== null && !stillPrimary) {
      setPrimaryActiveWorktreeRow(null)
    }
  }

  const getActiveSurfaceVariant = useCallback(
    (row: WorkspaceItemRow): ActiveSurfaceVariant => {
      const worktree = getWorkspaceItemRowWorktree(row)
      const rowIdentity = getWorktreeHostIdentity(worktree)
      if (primaryActiveWorktreeRow?.worktreeIdentity === rowIdentity) {
        return primaryActiveWorktreeRow.rowKey === getWorkspaceItemRowKey(row)
          ? 'primary'
          : 'secondary'
      }
      if (
        pinnedDisplayPolicy === 'duplicate-in-groups' &&
        activeWorktreeId === worktree.id &&
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
      const row = rowsRef.current.find(
        (candidate) =>
          isWorkspaceItemRow(candidate) &&
          getWorkspaceItemRowWorktree(candidate).id === worktreeId &&
          getWorkspaceItemRowKey(candidate) === rowKey
      )
      setPrimaryActiveWorktreeRow(
        rowKey && row && isWorkspaceItemRow(row)
          ? {
              worktreeIdentity: getWorktreeHostIdentity(getWorkspaceItemRowWorktree(row)),
              rowKey
            }
          : null
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
