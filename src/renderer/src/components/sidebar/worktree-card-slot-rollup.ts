import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import {
  toLineageSlotRecord,
  fromLineageSlotRecord,
  mergeRecord,
  type LineageSlotRecord
} from './worktree-card-slot-summary'
import { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
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
  type WorktreeLineageSource,
  type WorktreeLineageTree
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

type WorkspaceSlot = { targets: SlotTarget[]; record: LineageSlotRecord; latestAt: number | null }
const ownSelectors = new Map<
  HostScopedWorktreeKey,
  ReturnType<typeof createWorktreeAgentRowsSelector>
>()

let ownSlotInputs: readonly unknown[] = []
const ownSlots = new Map<
  HostScopedWorktreeKey,
  { worktree: Worktree | undefined; slot: WorkspaceSlot }
>()

function ownSlot(
  state: AppState,
  identity: HostScopedWorktreeKey,
  fallback?: Worktree
): WorkspaceSlot {
  const inputs = worktreeAgentProjectionInputs(state)
  if (!inputs.every((value, index) => value === ownSlotInputs[index])) {
    ownSlotInputs = inputs
    ownSlots.clear()
  }
  const cached = ownSlots.get(identity)
  const worktree = worktreeForIdentity(state, identity) ?? fallback ?? cached?.worktree
  if (cached && cached.worktree === worktree) {
    return cached.slot
  }
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
  const signals = buildSlotAgentSignals(agents, selectAgentRowsUnread(state, agents))
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
  ownSlots.set(identity, { worktree, slot: result })
  return result
}

type TreeSlots = {
  inputs: readonly unknown[]
  own: WorkspaceSlot[]
  descendants: LineageSlotRecord[]
  latest: (number | null)[]
}
const treeSlots = new WeakMap<WorktreeLineageTree, TreeSlots>()
function slotsForTree(state: AppState, tree: WorktreeLineageTree): TreeSlots {
  const inputs = worktreeAgentProjectionInputs(state)
  const cached = treeSlots.get(tree)
  if (cached && inputs.every((value, index) => value === cached.inputs[index])) {
    return cached
  }
  const own = tree.identities.map((identity, index) =>
    ownSlot(state, identity, tree.worktrees[index])
  )
  const descendants = own.map(() => toLineageSlotRecord([]))
  const latest: (number | null)[] = own.map(() => null)
  for (let index = own.length - 1; index >= 0; index--) {
    const parent = tree.parents[index]!
    if (parent >= 0) {
      mergeRecord(descendants[parent]!, own[index]!.record)
      mergeRecord(descendants[parent]!, descendants[index]!)
      latest[parent] =
        Math.max(latest[parent] ?? 0, own[index]!.latestAt ?? 0, latest[index] ?? 0) || null
    }
  }
  const result = { inputs, own, descendants, latest }
  treeSlots.set(tree, result)
  return result
}

export function collectLineageSlotTargets(
  state: AppState,
  source: WorktreeLineageSource
): SlotTarget[] {
  if (isLineageRange(source)) {
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
    ? (fromLineageSlotRecord(slotsForTree(state, source.tree).descendants[source.index]!)[0] ??
        null)
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
        ? slotsForTree(state, source.tree).descendants[source.index]!
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
    return slotsForTree(state, source.tree).latest[source.index]!
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
  mergeRecord(record, slots.descendants[range.index]!)
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
    children.flatMap((child) => {
      if (childSlot(state, child, source)?.kind !== kind) {
        return []
      }
      const range = childRange(source, child)
      return [
        ...ownSlot(state, child).targets,
        ...(range ? collectLineageSlotTargets(state, range) : [])
      ]
    }),
    kind
  )
}
