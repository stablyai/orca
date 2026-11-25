import { useAppStore } from '@/store'
import { useMemo } from 'react'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from './render-row'
import { buildLineageRowProjection, type LineageRowProjection } from './lineage-row-projection'

export function useDraggedSubtreeRanges(
  projection: LineageRowProjection,
  identity: string | null
): readonly { start: number; end: number }[] {
  return useMemo(
    () =>
      (identity ? (projection.occurrencesByIdentity.get(identity) ?? []) : []).map((start) => ({
        start,
        end: projection.frames[start].end
      })),
    [projection, identity]
  )
}

export function useLineageRowProjection(args: {
  rows: RenderRow[]
  groupBy: WorktreeGroupBy
  newCardStyle: boolean
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
}) {
  const { rows, groupBy, newCardStyle, activeWorktreeId, activeWorkspaceExecutionHostId } = args
  const statusLane = useAppStore((s) => s.worktreeCardProperties.includes('status')) && newCardStyle
  const projection = useMemo(
    () => buildLineageRowProjection(rows, groupBy, newCardStyle, statusLane),
    [rows, groupBy, newCardStyle, statusLane]
  )
  const firstHeaderIndex = useMemo(
    () => rows.findIndex((row) => row.type === 'header' || row.type === 'host-header'),
    [rows]
  )
  const activeFamilyRoots = useMemo(() => {
    const roots = new Set<number>()
    if (activeWorktreeId) {
      const addRoots = (occurrences: readonly number[]) => {
        for (const index of occurrences) {
          const root = projection.frames[index].root
          if (projection.frames[root].end > root) {
            roots.add(root)
          }
        }
      }
      if (activeWorkspaceExecutionHostId) {
        addRoots(
          projection.occurrencesByIdentity.get(
            composeWorktreeHostIdentity(activeWorkspaceExecutionHostId, activeWorktreeId)
          ) ?? []
        )
      } else {
        for (const [identity, occurrences] of projection.occurrencesByIdentity) {
          if (getWorktreeIdFromHostIdentity(identity) === activeWorktreeId) {
            addRoots(occurrences)
          }
        }
      }
    }
    return roots
  }, [activeWorktreeId, activeWorkspaceExecutionHostId, projection])
  return { projection, activeFamilyRoots, firstHeaderIndex }
}
