import type { WorkspaceSessionState } from './workspace-session-state-types'
import {
  prunePresentationLayout,
  sourceBaseline,
  workspaceEntityKey,
  type WorkspacePresentation,
  type WorkspaceSourceBaseline,
  type WorkspaceTabPresentation
} from './workspace-presentation'

const same = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)

/** Baselines compare edits, never supply missing members. Content always comes from the raw source. */
export function reconcileWorkspacePresentation(
  saved: WorkspacePresentation,
  sources: readonly WorkspaceSourceBaseline[],
  semanticEdit?: (key: string) => void
): WorkspacePresentation {
  if (
    sources.length === saved.baseline.length &&
    sources.every((source, index) => source === saved.baseline[index])
  ) {
    return saved
  }
  const live = new Map<string, WorkspaceTabPresentation>()
  for (const source of sources) {
    for (const tab of source.tabs) {
      live.set(workspaceEntityKey(tab.entity), tab)
    }
  }
  const priorSources = new Map(saved.baseline.map((entry) => [JSON.stringify(entry.source), entry]))
  const placements = new Map(saved.tabs.map((tab) => [workspaceEntityKey(tab.entity), tab]))
  const groups = new Map(saved.groups.map((group) => [group.id, group]))
  let layout = saved.layout
  let activeGroupId = saved.activeGroupId
  for (const source of sources) {
    const prior = priorSources.get(JSON.stringify(source.source))
    if (source === prior) {
      continue
    }
    const sourceGroupIds = new Set(source.groups.map((group) => group.id))
    const before = new Map((prior?.tabs ?? []).map((tab) => [workspaceEntityKey(tab.entity), tab]))
    for (const tab of source.tabs) {
      const key = workspaceEntityKey(tab.entity)
      const placed = placements.get(key)
      const base = before.get(key)
      if (!placed) {
        const groupId =
          groups.has(tab.groupId) || (prior && sourceGroupIds.has(tab.groupId))
            ? tab.groupId
            : (activeGroupId ?? groups.keys().next().value ?? tab.groupId)
        placements.set(key, { ...tab, groupId })
        continue
      }
      if (!base) {
        continue
      }
      // Omitted fields are the old codec's default, not an instruction to clear a user choice.
      const edited = { ...placed }
      for (const field of [
        'customLabel',
        'color',
        'isPinned',
        'viewMode',
        'lastFocusedAt'
      ] as const) {
        if (tab[field] !== undefined && tab[field] !== base[field]) {
          Object.assign(edited, { [field]: tab[field] })
          semanticEdit?.(`tab:${placed.id}:${field}`)
        }
      }
      if (tab.groupId !== base.groupId) {
        edited.groupId = tab.groupId
        semanticEdit?.(`tab:${placed.id}:groupId`)
      }
      placements.set(key, same(edited, placed) ? placed : edited)
    }
    if (prior) {
      const priorGroups = new Map(prior.groups.map((group) => [group.id, group]))
      const sourceIds = new Set(source.tabs.map((tab) => tab.id))
      const commonIds = new Set(
        source.tabs.filter((tab) => before.has(workspaceEntityKey(tab.entity))).map((tab) => tab.id)
      )
      const movedExisting = source.tabs.some((tab) => {
        const old = before.get(workspaceEntityKey(tab.entity))
        return old && old.groupId !== tab.groupId
      })
      for (const group of source.groups) {
        const base = priorGroups.get(group.id)
        const current = groups.get(group.id)
        if (!current) {
          groups.set(group.id, { ...group, worktreeId: saved.displayWorkspaceId })
          continue
        }
        const groupIds = new Set(group.tabOrder)
        const common = new Set(base?.tabOrder.filter((id) => groupIds.has(id)) ?? [])
        const reordered = !same(
          base?.tabOrder.filter((id) => common.has(id)),
          group.tabOrder.filter((id) => common.has(id))
        )
        const selectionEdited = base && group.activeTabId !== base.activeTabId
        if (reordered && base) {
          semanticEdit?.(`order:${group.id}`)
        }
        if (
          selectionEdited &&
          (!base.activeTabId || commonIds.has(base.activeTabId)) &&
          (group.activeTabId
            ? commonIds.has(group.activeTabId)
            : group.tabOrder.some((id) => commonIds.has(id)))
        ) {
          semanticEdit?.(`selection:${group.id}`)
        }
        if (reordered || selectionEdited) {
          let at = 0
          const order = group.tabOrder.filter((id) => sourceIds.has(id))
          groups.set(group.id, {
            ...current,
            tabOrder: reordered
              ? current.tabOrder.map((id) => (sourceIds.has(id) ? (order[at++] ?? id) : id))
              : current.tabOrder,
            ...(selectionEdited
              ? { activeTabId: group.activeTabId, recentTabIds: group.recentTabIds }
              : {})
          })
        }
      }
      if (source.activeGroupId !== prior.activeGroupId && source.activeGroupId) {
        activeGroupId = source.activeGroupId
        const priorActive = prior.groups.find((group) => group.id === prior.activeGroupId)
        if (movedExisting || priorActive?.tabOrder.some((id) => commonIds.has(id))) {
          semanticEdit?.('selection')
        }
      }
      const ownGroups = new Set(
        source.groups.filter((group) => group.tabOrder.length > 0).map((group) => group.id)
      )
      const oldLayout = prunePresentationLayout(prior.layout, ownGroups)
      const newLayout = prunePresentationLayout(source.layout, ownGroups)
      if (!same(oldLayout, newLayout) && newLayout) {
        const commonGroups = new Set(
          source.tabs
            .filter((tab) => {
              const old = before.get(workspaceEntityKey(tab.entity))
              return old && old.groupId === tab.groupId
            })
            .map((tab) => tab.groupId)
        )
        if (
          movedExisting ||
          !same(
            prunePresentationLayout(prior.layout, commonGroups),
            prunePresentationLayout(source.layout, commonGroups)
          )
        ) {
          semanticEdit?.('layout')
        }
        const sourceEntities = new Set(source.tabs.map((tab) => workspaceEntityKey(tab.entity)))
        const otherGroups = new Set(
          [...placements.values()]
            .filter((tab) => !sourceEntities.has(workspaceEntityKey(tab.entity)))
            .map((tab) => tab.groupId)
        )
        const replaceable = new Set(
          prior.groups.map((group) => group.id).filter((id) => !otherGroups.has(id))
        )
        let inserted = false
        const replace = (node: typeof layout): typeof layout => {
          if (!node) {
            return undefined
          }
          if (node.type === 'leaf') {
            if (!replaceable.has(node.groupId)) {
              return node
            }
            if (inserted) {
              return undefined
            }
            inserted = true
            return newLayout
          }
          const first = replace(node.first),
            second = replace(node.second)
          return first && second ? { ...node, first, second } : (first ?? second)
        }
        layout = replace(layout)
        if (!inserted && !otherGroups.size) {
          layout = newLayout
        }
      }
    }
  }
  const tabs = [...placements].filter(([key]) => live.has(key)).map(([, tab]) => tab)
  const ids = new Set(tabs.map((tab) => tab.id))
  const byGroup = new Map<string, string[]>()
  for (const tab of tabs) {
    const order = byGroup.get(tab.groupId) ?? []
    order.push(tab.id)
    byGroup.set(tab.groupId, order)
  }
  const lostGroups = new Set(
    saved.tabs.filter((tab) => !live.has(workspaceEntityKey(tab.entity))).map((tab) => tab.groupId)
  )
  const preservedGroups = new Set(saved.groups)
  const orderedGroups = [...groups.values()].flatMap((group) => {
    const own = new Set(byGroup.get(group.id) ?? [])
    const order = [...new Set([...group.tabOrder.filter((id) => own.has(id)), ...own])]
    if (!order.length) {
      return !lostGroups.has(group.id) && tabs.length > 0 && preservedGroups.has(group)
        ? [{ ...group, tabOrder: [], activeTabId: null }]
        : []
    }
    byGroup.delete(group.id)
    return [
      {
        ...group,
        tabOrder: order,
        activeTabId: group.activeTabId && own.has(group.activeTabId) ? group.activeTabId : order[0],
        recentTabIds: group.recentTabIds?.filter((id) => ids.has(id))
      }
    ]
  })
  for (const [groupId, tabOrder] of byGroup) {
    orderedGroups.push({
      id: groupId,
      worktreeId: saved.displayWorkspaceId,
      activeTabId: tabOrder[0],
      tabOrder
    })
  }
  const validGroups = new Set(orderedGroups.map((group) => group.id))
  layout = prunePresentationLayout(layout, validGroups)
  const leaves = new Set<string>()
  const visit = (node: typeof layout): void => {
    if (!node) {
      return
    }
    if (node.type === 'leaf') {
      leaves.add(node.groupId)
    } else {
      visit(node.first)
      visit(node.second)
    }
  }
  visit(layout)
  for (const group of orderedGroups) {
    if (!leaves.has(group.id)) {
      const leaf = { type: 'leaf' as const, groupId: group.id }
      layout = layout
        ? { type: 'split', direction: 'horizontal', first: layout, second: leaf }
        : leaf
      leaves.add(group.id)
    }
  }

  const next: WorkspacePresentation = {
    ...saved,
    tabs,
    groups: orderedGroups,
    layout,
    activeGroupId:
      activeGroupId && validGroups.has(activeGroupId) ? activeGroupId : orderedGroups[0]?.id,
    baseline: [...sources]
  }
  return same(saved, next) ? saved : next
}

export function presentationSourceBaselines(
  saved: WorkspacePresentation,
  sessionFor: (hostId: WorkspacePresentation['anchor']['hostId']) => WorkspaceSessionState
): WorkspaceSourceBaseline[] {
  return saved.baseline.map(({ source }) => sourceBaseline(sessionFor(source.hostId), source))
}

export { composeWorkspacePresentation } from './workspace-presentation-compose'
