// Why: declarative layout-rules helpers. `resolveTargetGroup` is the
// single source of truth for "which group does a new entity land in".

import type { TabGroup } from '../../../shared/types'
import {
  groupAllowsContentKind,
  ruleKeyForContentKind,
  type LayoutConfig,
  type LayoutGroupKind
} from '../../../shared/orca-yaml-layout'
import { planLayoutSeed, type LayoutSeedOp, type LayoutSeedPlan } from './layout-planner'

export { planLayoutSeed }
export type { LayoutSeedOp, LayoutSeedPlan }

/**
 * Look up the effective `kind` for a group. First checks the direct
 * `TabGroup.kind` stamp (set at seed time and propagated to split-
 * derived siblings); falls back to deriving from layoutGroupName +
 * config for groups stamped by older sessions. `undefined` and
 * `'mixed'` are treated identically at the callsite.
 */
export function getGroupKindForUuid(args: {
  worktreeId: string
  groupId: string
  groupsByWorktree?: Record<string, TabGroup[]>
  layoutConfigByWorktree: Record<string, LayoutConfig | undefined>
  layoutGroupIdByName: Record<string, Record<string, string> | undefined>
}): LayoutGroupKind | undefined {
  const directGroup = args.groupsByWorktree?.[args.worktreeId]?.find((g) => g.id === args.groupId)
  if (directGroup?.kind) {
    return directGroup.kind
  }
  const config = args.layoutConfigByWorktree[args.worktreeId]
  const nameMap = args.layoutGroupIdByName[args.worktreeId] ?? {}
  if (!config?.groups) {
    return undefined
  }
  for (const [name, declared] of Object.entries(nameMap)) {
    if (declared === args.groupId) {
      return config.groups[name]?.kind
    }
  }
  return undefined
}

// Why: priority chain explicit > rule > active > first-allowing >
// undefined; each step gated by kind-lock so a locked active group
// can't strand mismatched content.
export function resolveTargetGroup(args: {
  worktreeId: string
  contentKind: string
  explicitGroupId: string | null | undefined
  activeGroupId?: string | null | undefined
  groupsByWorktree: Record<string, TabGroup[]>
  layoutConfigByWorktree: Record<string, LayoutConfig | undefined>
  layoutGroupIdByName: Record<string, Record<string, string> | undefined>
}): string | undefined {
  const { worktreeId, contentKind, explicitGroupId, activeGroupId } = args
  const groups = args.groupsByWorktree[worktreeId] ?? []
  const groupExists = (id: string | null | undefined): id is string =>
    !!id && groups.some((g) => g.id === id)

  // Why: split-derived groups carry kind directly; YAML-name fallback
  // alone would miss inherited kinds and pick mismatched groups.
  const allows = (groupId: string): boolean =>
    groupAllowsContentKind(
      getGroupKindForUuid({
        worktreeId,
        groupId,
        groupsByWorktree: args.groupsByWorktree,
        layoutConfigByWorktree: args.layoutConfigByWorktree ?? {},
        layoutGroupIdByName: args.layoutGroupIdByName ?? {}
      }),
      contentKind
    )

  const config = args.layoutConfigByWorktree?.[worktreeId]
  const nameMap = args.layoutGroupIdByName?.[worktreeId] ?? {}

  if (groupExists(explicitGroupId) && allows(explicitGroupId)) {
    return explicitGroupId
  }

  const ruleKey = ruleKeyForContentKind(contentKind)
  if (ruleKey) {
    const targetName = config?.rules?.[ruleKey]
    if (targetName) {
      const resolvedId = nameMap[targetName]
      if (groupExists(resolvedId)) {
        return resolvedId
      }
    }
  }

  // Why: active is legacy fallback but only if its kind accepts;
  // otherwise pick first allowing so locked active doesn't strand.
  if (groupExists(activeGroupId) && allows(activeGroupId)) {
    return activeGroupId
  }
  for (const g of groups) {
    if (allows(g.id)) {
      return g.id
    }
  }
  return undefined
}

// Why: thunk-based reads (not a snapshot field) so callers that mutate
// the store before applying the seed see live state in the empty-
// precondition check (used in the late-reseed teardown path).
export type SeedStoreActions = {
  getGroupsForWorktree: (worktreeId: string) => TabGroup[]
  ensureWorktreeRootGroup: (worktreeId: string) => string
  createEmptySplitGroup: (
    worktreeId: string,
    sourceGroupId: string,
    direction: 'left' | 'right' | 'up' | 'down'
  ) => string | null
  focusGroup: (worktreeId: string, groupId: string) => void
  recordLayoutGroupBinding: (worktreeId: string, groupName: string, groupId: string) => void
}

// Why: reseed happens only on a pristine worktree (one default group +
// the activation auto-spawn terminal). User-modified layouts pass
// through untouched.
export type LateReseedActions = SeedStoreActions & {
  getTabsForWorktree: (
    worktreeId: string
  ) => { id: string; pendingActivationSpawn?: boolean | number }[]
  closeTab: (tabId: string) => void
  closeEmptyGroup: (worktreeId: string, groupId: string) => boolean
  recreateInitialTerminal: (worktreeId: string) => void
}

export function tryReseedAfterLateConfigArrival(
  worktreeId: string,
  config: LayoutConfig,
  actions: LateReseedActions
): boolean {
  const groups = actions.getGroupsForWorktree(worktreeId)
  if (groups.length !== 1) {
    return false
  }
  const tabs = actions.getTabsForWorktree(worktreeId)
  if (tabs.length > 1) {
    return false
  }
  if (tabs.length === 1 && !tabs[0].pendingActivationSpawn) {
    return false
  }
  if (tabs.length === 1) {
    actions.closeTab(tabs[0].id)
  }
  actions.closeEmptyGroup(worktreeId, groups[0].id)
  const seeded = applyLayoutSeed(worktreeId, config, actions)
  if (!seeded) {
    return false
  }
  actions.recreateInitialTerminal(worktreeId)
  return true
}

export function applyLayoutSeed(
  worktreeId: string,
  config: LayoutConfig,
  actions: SeedStoreActions
): boolean {
  if (actions.getGroupsForWorktree(worktreeId).length > 0) {
    return false
  }
  const plan = planLayoutSeed(config)
  if (!plan) {
    return false
  }

  const idByName: Record<string, string> = {}
  for (const op of plan.ops) {
    if (op.kind === 'init') {
      const rootId = actions.ensureWorktreeRootGroup(worktreeId)
      idByName[op.name] = rootId
      actions.recordLayoutGroupBinding(worktreeId, op.name, rootId)
      continue
    }
    const sourceId = idByName[op.sourceName]
    if (!sourceId) {
      // Defensive: planner guarantees source exists by the time the op runs,
      // but if someone hand-edits the plan we don't want a crash.
      continue
    }
    const newId = actions.createEmptySplitGroup(worktreeId, sourceId, op.direction)
    if (!newId) {
      continue
    }
    idByName[op.newName] = newId
    actions.recordLayoutGroupBinding(worktreeId, op.newName, newId)
  }
  const initialActive = idByName[plan.initialActiveGroupName]
  if (initialActive) {
    actions.focusGroup(worktreeId, initialActive)
  }
  return true
}
