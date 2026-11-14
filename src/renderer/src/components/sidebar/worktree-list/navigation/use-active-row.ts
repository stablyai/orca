import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../../../../../../shared/sidebar-list/row-types'
import { isPinnedWorktreeRow, type WorktreeItemRow } from '../listing/renderable-rows'

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
          row.type === 'item' &&
          composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id) ===
            current.worktreeIdentity &&
          row.rowKey === current.rowKey
      )
    if (current !== null && !stillPrimary) {
      setPrimaryActiveWorktreeRow(null)
    }
  }

  const getActiveSurfaceVariant = useCallback(
    (row: WorktreeItemRow): ActiveSurfaceVariant => {
      const rowIdentity = composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id)
      if (primaryActiveWorktreeRow?.worktreeIdentity === rowIdentity) {
        return primaryActiveWorktreeRow.rowKey === row.rowKey ? 'primary' : 'secondary'
      }
      if (
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
      const row = rowsRef.current.find(
        (candidate) =>
          candidate.type === 'item' &&
          candidate.worktree.id === worktreeId &&
          candidate.rowKey === rowKey
      )
      setPrimaryActiveWorktreeRow(
        rowKey && row?.type === 'item'
          ? {
              worktreeIdentity: composeWorktreeHostIdentity(row.worktree.hostId, worktreeId),
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
