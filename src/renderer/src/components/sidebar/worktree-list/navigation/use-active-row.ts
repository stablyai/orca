import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../WorktreeCard'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
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

  useLayoutEffect(() => {
    if (activeWorktreeId === null) {
      setPrimaryActiveWorktreeRow(null)
      return
    }
    setPrimaryActiveWorktreeRow((current) => {
      if (current === null || current.worktreeIdentity !== activeIdentity) {
        return null
      }
      const rowStillVisible = rows.some(
        (row) =>
          row.type === 'item' &&
          composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id) ===
            current.worktreeIdentity &&
          row.rowKey === current.rowKey
      )
      return rowStillVisible ? current : null
    })
  }, [activeIdentity, activeWorktreeId, rows])

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
