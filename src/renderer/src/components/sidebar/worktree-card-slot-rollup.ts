import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { createLineageSlotReader, type WorkspaceSlot } from './worktree-card-slot-range'
import type { DashboardAgentRow } from '@/components/dashboard/rows/dashboard-agent-row'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  toLineageSlotRecord,
  fromLineageSlotRecord,
  mergeRecord,
  type LineageSlotRecord
} from './worktree-card-slot-summary'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import {
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  type HostScopedWorktreeKey
} from '../../../../shared/worktree/host-qualified-identity'
import {
  isLineageRange,
  lineageIdentities,
  type WorktreeLineageSource
} from '../../../../shared/sidebar-list/worktree-lineage-range'
import {
  EMPTY_AGENT_ROWS,
  getSharedWorktreeAgentRowsSelector,
  worktreeAgentProjectionInputs
} from './workspace-card/activity/worktree-agent-rows-projection'
import { selectAgentRowsUnread } from './workspace-card/activity/worktree-card-agent-ack-inputs'
import { buildSlotAgentSignals } from './worktree-card-slot-agent-signals'
import { recordDisplayedPanes } from './worktree-card-slot-pane-index'
import { slotExceptionsFor, type SlotException } from './worktree-card-slot-signal'
import {
  slotTargetsFromAgentLines,
  workspaceUnreadTarget,
  type SlotTarget
} from './worktree-card-slot-targets'

function worktreeForIdentity(
  state: AppState,
  identity: HostScopedWorktreeKey
): Worktree | undefined {
  return getIndexedWorktreesById(
    selectWorktreesByRepo(state),
    getWorktreeIdFromHostIdentity(identity)
  ).find((row) => getWorktreeHostIdentity(row) === identity)
}

const ownSlots = new Map<
  HostScopedWorktreeKey,
  {
    worktree: Worktree | undefined
    hostId: ExecutionHostId | null
    slot: WorkspaceSlot
    agents: DashboardAgentRow[]
    unread: boolean[]
  }
>()

function ownSlot(
  state: AppState,
  identity: HostScopedWorktreeKey,
  fallback?: Worktree
): WorkspaceSlot {
  const cached = ownSlots.get(identity)
  const worktree = worktreeForIdentity(state, identity) ?? fallback ?? cached?.worktree
  const worktreeId = getWorktreeIdFromHostIdentity(identity)
  const hostId =
    getExecutionHostIdFromWorktreeHostIdentity(identity) ??
    getResolvedExecutionHostIdForWorktree(state, worktreeId)
  const agents = hostId
    ? getSharedWorktreeAgentRowsSelector(worktreeId, hostId)(state)
    : EMPTY_AGENT_ROWS
  const unread = selectAgentRowsUnread(state, agents)
  if (
    cached &&
    cached.worktree === worktree &&
    cached.hostId === hostId &&
    cached.agents === agents &&
    unread.length === cached.unread.length &&
    unread.every((value, index) => value === cached.unread[index])
  ) {
    // Refresh recency so the cap evicts least recently used, not oldest inserted.
    ownSlots.delete(identity)
    ownSlots.set(identity, cached)
    return cached.slot
  }
  // Invalidation finds this slot through the panes it was built from.
  recordDisplayedPanes(
    identity,
    agents.flatMap((agent) =>
      agent.activationPaneKey && agent.activationPaneKey !== agent.paneKey
        ? [agent.paneKey, agent.activationPaneKey]
        : [agent.paneKey]
    )
  )
  const signals = buildSlotAgentSignals(agents, unread)
  const targets = slotTargetsFromAgentLines(worktreeId, signals, hostId ?? undefined)
  if (worktree?.isUnread) {
    targets.push(
      workspaceUnreadTarget(worktree.id, worktree.lastActivityAt || null, hostId ?? undefined)
    )
  }
  const at = Math.max(
    worktree?.lastActivityAt ?? 0,
    ...agents.map((agent) => agent.entry.stateStartedAt)
  )
  const result = {
    targets,
    record: toLineageSlotRecord(slotExceptionsFor(targets)),
    latestAt: at > 0 ? at : null
  }
  ownSlots.delete(identity)
  ownSlots.set(identity, { worktree, hostId, slot: result, agents, unread })
  if (ownSlots.size > 2048) {
    ownSlots.delete(ownSlots.keys().next().value!)
  }
  return result
}

const { descendantSlots, descendantSlot } = createLineageSlotReader(ownSlot)

/** What the card shows as unread: its flag, or an agent result the user hasn't read. */
export function selectWorkspaceShowsUnread(state: AppState, worktree: Worktree): boolean {
  return (
    worktree.isUnread ||
    ownSlot(state, getWorktreeHostIdentity(worktree), worktree).targets.some(
      (target) => target.kind === 'unread'
    )
  )
}

export function collectLineageSlotTargets(
  state: AppState,
  source: WorktreeLineageSource
): SlotTarget[] {
  if (isLineageRange(source)) {
    if (source.length === 0) {
      return []
    }
    return descendantSlots(state, source.tree, source.index).flatMap((slot) => slot.targets)
  }
  return source.flatMap((identity) => ownSlot(state, identity).targets)
}

export function selectCollapsedLineageSlots(
  state: AppState,
  source: WorktreeLineageSource
): LineageSlotRecord {
  return selectLineageSlot(state, source).record
}

function selectLineageSlot(
  state: AppState,
  source: WorktreeLineageSource
): Pick<WorkspaceSlot, 'record' | 'latestAt'> {
  if (isLineageRange(source)) {
    return descendantSlot(state, source.tree, source.index)
  }
  const record = toLineageSlotRecord([])
  let latestAt = 0
  for (const identity of lineageIdentities(source)) {
    const slot = ownSlot(state, identity)
    mergeRecord(record, slot.record)
    latestAt = Math.max(latestAt, slot.latestAt ?? 0)
  }
  return { record, latestAt: latestAt || null }
}

function createLineageSlotSummarySelector(source: WorktreeLineageSource, collapsed: boolean) {
  let inputs: readonly unknown[] = []
  let summary: LineageSlotRecord & { latestAt: number | null } = {
    ...toLineageSlotRecord([]),
    latestAt: null
  }
  return (state: AppState) => {
    const next = worktreeAgentProjectionInputs(state)
    if (!next.every((value, index) => value === inputs[index])) {
      inputs = next
      const slot = selectLineageSlot(state, source)
      summary = {
        ...(collapsed ? slot.record : toLineageSlotRecord([])),
        latestAt: slot.latestAt
      }
    }
    return summary
  }
}

export function useLineageSlotSummary(
  source: WorktreeLineageSource,
  collapsed: boolean
): {
  exceptions: SlotException[]
  latestAt: number | null
} {
  const select = useMemo(
    () => createLineageSlotSummarySelector(source, collapsed),
    [source, collapsed]
  )
  const summary = useAppStore(useShallow(select))
  return useMemo(
    () => ({ exceptions: fromLineageSlotRecord(summary), latestAt: summary.latestAt }),
    [summary]
  )
}

export function selectLineageLatestAt(
  state: AppState,
  source: WorktreeLineageSource
): number | null {
  return selectLineageSlot(state, source).latestAt
}
