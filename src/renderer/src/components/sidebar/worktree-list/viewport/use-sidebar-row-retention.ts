import { folderWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { useCallback, useMemo, useState } from 'react'
import type React from 'react'
import { rowKeyMatchesRenderRow } from '../navigation/render-row-lookup'
import { getFolderWorkspaceHostId } from '../../folder-workspace-host-id'
import { useAppStore } from '@/store'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { SidebarGeometry } from '../listing/sidebar-geometry-slots'
import type { VirtualizedWorktreeViewportProps } from './viewport-props'

export type SidebarRetentionInputs = {
  defaultHostId: ExecutionHostId
  model: SidebarGeometry
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  pendingRevealWorktree: VirtualizedWorktreeViewportProps['pendingRevealWorktree']
  pendingRevealSidebarRow: VirtualizedWorktreeViewportProps['pendingRevealSidebarRow']
  draggingWorktreeId: string | null
}
export function useSidebarRowRetention(args: SidebarRetentionInputs) {
  const [interactedKey, retainKey] = useState<string | null>(null)
  const renaming = useAppStore((s) => s.renamingWorktreeId)
  const targets = useMemo(
    () =>
      args.model.nodes.flatMap((node, index) => {
        const interacted = node.key === interactedKey
        const pendingRow = args.pendingRevealSidebarRow
        const rowLanding = Boolean(
          pendingRow && rowKeyMatchesRenderRow(node.row, pendingRow.rowKey)
        )
        if (node.row.type === 'folder-workspace') {
          const folder = node.row.folderWorkspace
          const pending = args.pendingRevealWorktree
          const host = getFolderWorkspaceHostId(folder, node.row.projectGroup, args.defaultHostId)
          const landing =
            rowLanding ||
            (folderWorkspaceKey(folder.id) === pending?.worktreeId &&
              (!pending.executionHostId || host === pending.executionHostId))
          const active =
            folderWorkspaceKey(folder.id) === args.activeWorktreeId &&
            (!args.activeWorkspaceExecutionHostId || host === args.activeWorkspaceExecutionHostId)
          return interacted || landing || active ? [{ index, landing }] : []
        }
        if (node.row.type !== 'item') {
          return interacted || rowLanding ? [{ index, landing: rowLanding }] : []
        }
        const row = node.row
        const pending = args.pendingRevealWorktree
        const landing =
          rowLanding ||
          (row.worktree.id === pending?.worktreeId &&
            (!pending.executionHostId ||
              getWorktreeExecutionHostId(row.worktree, row.repo) === pending.executionHostId))
        const active =
          row.worktree.id === args.activeWorktreeId &&
          (!args.activeWorkspaceExecutionHostId ||
            getWorktreeExecutionHostId(row.worktree, row.repo) ===
              args.activeWorkspaceExecutionHostId)
        const rename = renaming?.rowKey
          ? row.rowKey === renaming.rowKey
          : row.worktree.id === renaming?.worktreeId
        return interacted ||
          landing ||
          active ||
          rename ||
          row.worktree.id === args.draggingWorktreeId
          ? [{ index, landing }]
          : []
      }),
    [
      args.model,
      args.defaultHostId,
      interactedKey,
      args.pendingRevealWorktree,
      args.pendingRevealSidebarRow,
      args.activeWorktreeId,
      args.activeWorkspaceExecutionHostId,
      args.draggingWorktreeId,
      renaming
    ]
  )
  const retainInteraction = useCallback((event: React.SyntheticEvent<HTMLElement>) => {
    if (event.target instanceof Element) {
      retainKey(
        event.target.closest<HTMLElement>('[data-sidebar-geometry-node]')?.dataset
          .sidebarGeometryNode ?? null
      )
    }
  }, [])
  return { targets, retainInteraction }
}
