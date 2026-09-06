import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import type { ActiveSurfaceVariant } from '../../WorktreeCard'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import type { HostSectionRow } from '../../host-section-rows'
import type { PinnedWorktreeDisplayPolicy } from '../grouping/row-types'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspace-worktree'
import { PINNED_GROUP_KEY } from '../grouping/group-keys'

/** The identity a row contributes to the active surface. Folder workspaces
 *  duplicate into Pinned exactly like worktrees, so both kinds resolve here. */
function getActiveSurfaceRowRef(
  row: HostSectionRow
): { rowKey: string; sectionKey: string; worktreeId: string; worktreeIdentity: string } | null {
  if (row.type === 'item') {
    return {
      rowKey: row.rowKey,
      sectionKey: row.sectionKey,
      worktreeId: row.worktree.id,
      worktreeIdentity: composeWorktreeHostIdentity(row.worktree.hostId, row.worktree.id)
    }
  }
  if (row.type === 'folder-workspace') {
    const worktree = folderWorkspaceToWorktree(row.folderWorkspace)
    return {
      rowKey: row.key,
      sectionKey: row.sectionKey,
      worktreeId: worktree.id,
      worktreeIdentity: composeWorktreeHostIdentity(worktree.hostId, worktree.id)
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
        const ref = getActiveSurfaceRowRef(row)
        return ref?.worktreeIdentity === current.worktreeIdentity && ref.rowKey === current.rowKey
      })
      return rowStillVisible ? current : null
    })
  }, [activeIdentity, activeWorktreeId, rows])

  const getActiveSurfaceVariant = useCallback(
    (row: HostSectionRow): ActiveSurfaceVariant => {
      const ref = getActiveSurfaceRowRef(row)
      if (!ref) {
        return 'primary'
      }
      if (primaryActiveWorktreeRow?.worktreeIdentity === ref.worktreeIdentity) {
        return primaryActiveWorktreeRow.rowKey === ref.rowKey ? 'primary' : 'secondary'
      }
      if (
        pinnedDisplayPolicy === 'duplicate-in-groups' &&
        activeWorktreeId === ref.worktreeId &&
        ref.sectionKey === PINNED_GROUP_KEY
      ) {
        return 'secondary'
      }
      return 'primary'
    },
    [activeWorktreeId, pinnedDisplayPolicy, primaryActiveWorktreeRow]
  )

  const handleImmediateWorktreeRowActivate = useCallback(
    (worktreeId: string, rowKey: string | undefined): void => {
      const ref = rowsRef.current
        .map(getActiveSurfaceRowRef)
        .find((candidate) => candidate?.worktreeId === worktreeId && candidate.rowKey === rowKey)
      setPrimaryActiveWorktreeRow(
        rowKey && ref ? { worktreeIdentity: ref.worktreeIdentity, rowKey } : null
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
