import { createLineageSlotReader, type WorkspaceSlot } from './worktree-card-slot-range'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  toLineageSlotRecord,
  fromLineageSlotRecord,
  type LineageSlotRecord
} from './worktree-card-slot-summary'
import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import type { Worktree } from '../../../../shared/worktree/types'
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
  getSharedWorktreeAgentRowsSelector,
  worktreeAgentProjectionInputs
} from './workspace-card/activity/worktree-agent-rows-projection'
import { selectAgentRowsUnread } from './workspace-card/activity/worktree-card-agent-ack-inputs'
import { buildSlotAgentSignals } from './worktree-card-slot-agent-signals'
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
  const agents = getSharedWorktreeAgentRowsSelector(
    getWorktreeIdFromHostIdentity(identity),
    getExecutionHostIdFromWorktreeHostIdentity(identity)
  )(state)
  const unread = selectAgentRowsUnread(state, agents)
  if (
    cached &&
    cached.worktree === worktree &&
    cached.agents === agents &&
    unread.length === cached.unread.length &&
    unread.every((value, index) => value === cached.unread[index])
  ) {
    // Refresh recency so the cap evicts least recently used, not oldest inserted.
    ownSlots.delete(identity)
    ownSlots.set(identity, cached)
    return cached.slot
  }
  const signals = buildSlotAgentSignals(agents, unread)
  const targets = slotTargetsFromAgentLines(
    getWorktreeIdFromHostIdentity(identity),
    signals,
    getExecutionHostIdFromWorktreeHostIdentity(identity)
  )
  if (worktree?.isUnread) {
    targets.push(
      workspaceUnreadTarget(worktree.id, worktree.lastActivityAt || null, worktree.hostId)
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
  ownSlots.set(identity, { worktree, slot: result, agents, unread })
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
  return isLineageRange(source)
    ? descendantSlot(state, source.tree, source.index).record
    : toLineageSlotRecord(slotExceptionsFor(collectLineageSlotTargets(state, source)))
}

function createCollapsedLineageSlotsSelector(source: WorktreeLineageSource) {
  let inputs: readonly unknown[] = []
  let record = toLineageSlotRecord([])
  return (state: AppState) => {
    const next = worktreeAgentProjectionInputs(state)
    if (!next.every((value, index) => value === inputs[index])) {
      inputs = next
      record = selectCollapsedLineageSlots(state, source)
    }
    return record
  }
}

export function useCollapsedLineageSlots(source: WorktreeLineageSource): SlotException[] {
  const select = useMemo(() => createCollapsedLineageSlotsSelector(source), [source])
  const record = useAppStore(useShallow(select))
  return useMemo(() => fromLineageSlotRecord(record), [record])
}

export function selectLineageLatestAt(
  state: AppState,
  source: WorktreeLineageSource
): number | null {
  if (isLineageRange(source)) {
    return descendantSlot(state, source.tree, source.index).latestAt
  }
  let at = 0
  for (const identity of lineageIdentities(source)) {
    at = Math.max(at, ownSlot(state, identity).latestAt ?? 0)
  }
  return at || null
}

function createLineageLatestAtSelector(source: WorktreeLineageSource) {
  let inputs: readonly unknown[] = []
  let at: number | null = null
  return (state: AppState) => {
    const next = worktreeAgentProjectionInputs(state)
    if (!next.every((value, index) => value === inputs[index])) {
      inputs = next
      at = selectLineageLatestAt(state, source)
    }
    return at
  }
}

export function useLineageLatestAt(source: WorktreeLineageSource): number | null {
  const select = useMemo(() => createLineageLatestAtSelector(source), [source])
  return useAppStore(select)
}
