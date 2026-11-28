import type { DashboardBucket } from '../../../../../../shared/agent-status/presentation/dashboard-snapshot'
import {
  dashboardRowBucketProjection,
  readAgentRowTurnRecords
} from '@/components/dashboard/rows/dashboard-row-bucket'
import { collectActiveDashboardOwnerIds } from '@/components/dashboard/snapshot/dashboard-snapshot-workspaces'
import {
  selectWorktreesByRepo,
  selectFolderWorkspaces
} from '../../../workspaces/catalog/workspace-record-fields'
import type { AppState } from '../../../types'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { readRecordChanges } from '../../../record-transitions/keyed-record-change-reads'
import { structuralValuesEqualIgnoringUndefined as equal } from '../../../../../../shared/collections/structural-value-equality'
import {
  type DashboardCounts,
  EMPTY_COUNTS,
  type CountedRow
} from './agent-status-projection-types'
import type { AgentStatusProjectionState } from './agent-status-projection-state'
import type { ProjectionRows } from './agent-status-projection-rows'

const EMPTY_ACTIVE_OWNERS: ReadonlySet<string> = new Set()

export function stageProjectionCounts(
  data: AgentStatusProjectionState,
  state: AppState,
  prepared: ProjectionRows['prepared']
): () => void {
  const previous = data.inputs
  const countRows = new Map<string, { row: DashboardAgentRow; owner?: string } | undefined>()
  for (const [source, next] of prepared) {
    for (const key of data.rowsForSource.get(source) ?? []) {
      countRows.set(key, undefined)
    }
    for (const row of next.rows) {
      countRows.set(row.paneKey, { row, owner: next.worktreeId })
    }
  }
  if (state.acknowledgedAgentsByPaneKey !== previous?.acknowledgedAgentsByPaneKey) {
    const diff = previous
      ? readRecordChanges(state.acknowledgedAgentsByPaneKey, previous.acknowledgedAgentsByPaneKey)
      : null
    const keys =
      diff?.kind === 'addressed'
        ? diff.keys
        : new Set([
            ...Object.keys(state.acknowledgedAgentsByPaneKey ?? {}),
            ...Object.keys(previous?.acknowledgedAgentsByPaneKey ?? {})
          ])
    for (const key of keys) {
      if (!countRows.has(key)) {
        const row = data.rows.get(key)
        countRows.set(key, row ? { row, owner: data.ownerForSource.get(key) } : undefined)
      }
    }
  }
  const ownersUnchanged =
    previous !== null &&
    previous.repos === state.repos &&
    selectWorktreesByRepo(previous) === selectWorktreesByRepo(state) &&
    selectFolderWorkspaces(previous) === selectFolderWorkspaces(state)
  const countUpdates = new Map<string, CountedRow | undefined>()
  const ownerCounts = new Map<string, Record<DashboardBucket, number>>()
  const adjust = (row: CountedRow, delta: number) => {
    let counts = ownerCounts.get(row.owner)
    if (!counts) {
      ownerCounts.set(
        row.owner,
        (counts = { ...(data.countsByWorktree.get(row.owner) ?? EMPTY_COUNTS) })
      )
    }
    counts[row.bucket] += delta
  }
  if (countRows.size > 0) {
    const turnRecords = readAgentRowTurnRecords(state)
    for (const [key, value] of countRows) {
      const row = value?.row
      const owner = value?.owner
      const before = data.countedRows.get(key)
      const after =
        row && owner && row.rowSource !== 'subagent'
          ? {
              owner,
              bucket: dashboardRowBucketProjection(row, turnRecords).bucket
            }
          : undefined
      if (before?.owner === after?.owner && before?.bucket === after?.bucket) {
        continue
      }
      if (before) {
        adjust(before, -1)
      }
      if (after) {
        adjust(after, 1)
      }
      countUpdates.set(key, after)
    }
  }
  if (data.countsByWorktree.size === 0 && ownerCounts.size === 0) {
    return () => {
      if (!ownersUnchanged) {
        data.activeDashboardOwners = null
      }
      for (const [key, row] of countUpdates) {
        if (row) {
          data.countedRows.set(key, row)
        } else {
          data.countedRows.delete(key)
        }
      }
    }
  }
  const previousActiveOwners = data.activeDashboardOwners ?? EMPTY_ACTIVE_OWNERS
  const nextActiveOwners =
    ownersUnchanged && data.activeDashboardOwners !== null
      ? data.activeDashboardOwners
      : collectActiveDashboardOwnerIds(state)
  const totals = { ...data.dashboardTotals }
  const adjustTotals = (counts: DashboardCounts, delta: number) => {
    for (const name of ['attention', 'working', 'done', 'idle'] as const) {
      totals[name] += counts[name] * delta
    }
  }
  for (const [owner, counts] of ownerCounts) {
    if (previousActiveOwners.has(owner)) {
      adjustTotals(data.countsByWorktree.get(owner) ?? EMPTY_COUNTS, -1)
      adjustTotals(counts, 1)
    }
  }
  if (nextActiveOwners !== previousActiveOwners) {
    for (const [owner, existingCounts] of data.countsByWorktree) {
      const wasActive = previousActiveOwners.has(owner)
      const isActive = nextActiveOwners.has(owner)
      if (wasActive !== isActive) {
        adjustTotals(ownerCounts.get(owner) ?? existingCounts, isActive ? 1 : -1)
      }
    }
    for (const [owner, counts] of ownerCounts) {
      if (data.countsByWorktree.has(owner)) {
        continue
      }
      const wasActive = previousActiveOwners.has(owner)
      const isActive = nextActiveOwners.has(owner)
      if (wasActive !== isActive) {
        adjustTotals(counts, isActive ? 1 : -1)
      }
    }
  }
  return () => {
    data.activeDashboardOwners = nextActiveOwners
    for (const [key, row] of countUpdates) {
      if (row) {
        data.countedRows.set(key, row)
      } else {
        data.countedRows.delete(key)
      }
    }
    for (const [owner, counts] of ownerCounts) {
      if (Object.values(counts).some(Boolean)) {
        data.countsByWorktree.set(owner, counts)
      } else {
        data.countsByWorktree.delete(owner)
      }
    }
    if (!equal(totals, data.dashboardTotals)) {
      data.dashboardTotals = totals
      data.notices.add('dashboard-counts')
    }
  }
}
