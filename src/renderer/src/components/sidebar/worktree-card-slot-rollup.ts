import { createLineageSlotReader, type WorkspaceSlot } from './worktree-card-slot-range'
import type { DashboardAgentRow } from '@/components/dashboard/useDashboardData'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import {
  toLineageSlotRecord,
  fromLineageSlotRecord,
  mergeRecord
} from './worktree-card-slot-summary'
import { useCallback, useMemo } from 'react'
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
  createWorktreeAgentRowsSelector,
  worktreeAgentProjectionInputs
} from './workspace-card/activity/worktree-agent-rows-projection'
import { selectAgentRowsUnread } from './workspace-card/activity/worktree-card-agent-ack-inputs'
import { buildSlotAgentSignals } from './worktree-card-slot-agent-signals'
import {
  slotExceptionFor,
  slotExceptionsFor,
  type SlotException,
  type SlotSignal
} from './worktree-card-slot-signal'
import {
  expandWorkspaceUnreadTargets,
  slotTargetsFromAgentLines,
  slotTargetsOfKind,
  workspaceUnreadTarget,
  type SlotTarget
} from './worktree-card-slot-targets'

export function worktreeForIdentity(
  state: AppState,
  identity: HostScopedWorktreeKey
): Worktree | undefined {
  return getIndexedWorktreesById(
    selectWorktreesByRepo(state),
    getWorktreeIdFromHostIdentity(identity)
  ).find((row) => getWorktreeHostIdentity(row) === identity)
}

const ownSelectors = new Map<
  HostScopedWorktreeKey,
  ReturnType<typeof createWorktreeAgentRowsSelector>
>()

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
  let selector = ownSelectors.get(identity)
  if (!selector) {
    selector = createWorktreeAgentRowsSelector(
      getWorktreeIdFromHostIdentity(identity),
      getExecutionHostIdFromWorktreeHostIdentity(identity)
    )
    ownSelectors.set(identity, selector)
    if (ownSelectors.size > 2048) {
      ownSelectors.delete(ownSelectors.keys().next().value!)
    }
  }
  const agents = selector(state)
  const unread = selectAgentRowsUnread(state, agents)
  if (
    cached &&
    cached.worktree === worktree &&
    cached.agents === agents &&
    unread.length === cached.unread.length &&
    unread.every((value, index) => value === cached.unread[index])
  ) {
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

const { slotsForTree, descendantSlot } = createLineageSlotReader(ownSlot)

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
    const slots = slotsForTree(state, source.tree)
    const result: SlotTarget[] = []
    for (let i = source.index + 1; i < source.tree.ends[source.index]!; i++) {
      result.push(...slots.own[i]!.targets)
    }
    return result
  }
  return source.flatMap((identity) => ownSlot(state, identity).targets)
}

export function selectCollapsedLineageSlot(
  state: AppState,
  source: WorktreeLineageSource
): SlotSignal | null {
  return isLineageRange(source)
    ? (fromLineageSlotRecord(descendantSlot(state, source.tree, source.index).record)[0] ?? null)
    : slotExceptionFor(collectLineageSlotTargets(state, source))
}

export function useCollapsedLineageSlots(source: WorktreeLineageSource): SlotException[] {
  const select = useMemo(() => {
    let inputs: readonly unknown[] = []
    let record = toLineageSlotRecord([])
    return (state: AppState) => {
      const next = worktreeAgentProjectionInputs(state)
      if (next.every((value, index) => value === inputs[index])) {
        return record
      }
      inputs = next
      record = isLineageRange(source)
        ? descendantSlot(state, source.tree, source.index).record
        : toLineageSlotRecord(slotExceptionsFor(collectLineageSlotTargets(state, source)))
      return record
    }
  }, [source])
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

export function useLineageLatestAt(source: WorktreeLineageSource): number | null {
  return useAppStore(
    useCallback((state: AppState) => selectLineageLatestAt(state, source), [source])
  )
}

function childRange(source: WorktreeLineageSource | undefined, identity: HostScopedWorktreeKey) {
  if (!source || !isLineageRange(source)) {
    return null
  }
  const index = source.tree.indexByIdentity.get(identity)
  return index === undefined
    ? null
    : { tree: source.tree, index, length: source.tree.ends[index]! - index - 1 }
}

function childSlot(
  state: AppState,
  identity: HostScopedWorktreeKey,
  source?: WorktreeLineageSource
) {
  const range = childRange(source, identity)
  if (!range) {
    return slotExceptionFor(ownSlot(state, identity).targets)
  }
  const slots = slotsForTree(state, range.tree)
  const record = { ...slots.own[range.index]!.record }
  mergeRecord(record, descendantSlot(state, range.tree, range.index).record)
  return fromLineageSlotRecord(record)[0] ?? null
}

export type LineageChildCounts = { needs: number; failed: number; unread: number; working: number }
export function selectLineageChildCounts(
  state: AppState,
  children: readonly HostScopedWorktreeKey[],
  source?: WorktreeLineageSource
): LineageChildCounts {
  const counts: LineageChildCounts = { needs: 0, failed: 0, unread: 0, working: 0 }
  for (const child of children) {
    const signal = childSlot(state, child, source)
    if (
      signal?.kind === 'needs' ||
      signal?.kind === 'failed' ||
      signal?.kind === 'unread' ||
      signal?.kind === 'working'
    ) {
      counts[signal.kind]++
    }
  }
  return counts
}

export function useLineageChildCounts(
  children: readonly HostScopedWorktreeKey[],
  source?: WorktreeLineageSource
): LineageChildCounts {
  const select = useMemo(() => {
    let inputs: readonly unknown[] = []
    let counts: LineageChildCounts = { needs: 0, failed: 0, unread: 0, working: 0 }
    return (state: AppState) => {
      const next = worktreeAgentProjectionInputs(state)
      if (next.every((value, index) => value === inputs[index])) {
        return counts
      }
      inputs = next
      counts = selectLineageChildCounts(state, children, source)
      return counts
    }
  }, [children, source])
  return useAppStore(useShallow(select))
}

export function collectLineageChildTargetsOfKind(
  state: AppState,
  children: readonly HostScopedWorktreeKey[],
  kind: keyof LineageChildCounts,
  source?: WorktreeLineageSource
): SlotTarget[] {
  return slotTargetsOfKind(
    expandWorkspaceUnreadTargets(
      state,
      children.flatMap((child) => {
        if (childSlot(state, child, source)?.kind !== kind) {
          return []
        }
        const range = childRange(source, child)
        return [
          ...ownSlot(state, child).targets,
          ...(range ? collectLineageSlotTargets(state, range) : [])
        ]
      })
    ),
    kind
  )
}
