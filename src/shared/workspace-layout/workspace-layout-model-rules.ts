// The structural rules, checked on the model itself: what the Serializer would drop or repair on
// the way to disk (an ungrouped tab, an empty group, a group tree naming other groups) is a
// breach here. The disk-format rules (workspace-layout-rules.ts) check what older builds write.

import type { TabGroupLayoutNode } from '../tab-types'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { checkLayoutIdStability, type LayoutEntities } from './workspace-layout-id-stability'
import type { LoadedWorkspaceLayout } from './workspace-layout-load-types'
import type { WorkspaceLayout, WorkspaceLayoutModel } from './workspace-layout-model'
import { checkPaneOwners, paneOwnerGroups } from './workspace-layout-rules'
import type { PaneOwner, WorkspaceLayoutViolation } from './workspace-layout-rule-types'

/** Nothing beside the layout: no view selection, facts or pass-through fields. */
export function emptyLayoutBeside(): Omit<LoadedWorkspaceLayout, 'layout'> {
  return {
    desktopView: {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      groups: {},
      lastFocusedAt: {},
      panes: {},
      editorDrafts: {}
    },
    facts: { tabLabels: {}, terminalRows: {}, scrollback: {}, browserTabs: {} },
    carried: {
      unownedTerminalLayouts: {},
      unplacedSleepingRecords: {},
      unplacedIncarnations: {},
      unplacedClosedTabs: {}
    }
  }
}

function groupTreeIds(node: TabGroupLayoutNode | undefined): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.groupId]
    : [...groupTreeIds(node.first), ...groupTreeIds(node.second)]
}

function paneOwners(model: WorkspaceLayoutModel): PaneOwner[] {
  return Object.values(model.workspaces).flatMap(({ worktreeId, tabs, leaves }) =>
    tabs.flatMap((tab) =>
      tab.kind === 'terminal'
        ? collectLayoutLeafIdsInOrder(tab.panes.root).map((leafId) => ({
            hostId: model.hostId,
            worktreeId,
            tab: { id: tab.entityId },
            leafId,
            ptyId: leaves?.[leafId]?.ptyId,
            incarnationId: leaves?.[leafId]?.incarnationId
          }))
        : []
    )
  )
}

function checkWorkspace(
  model: WorkspaceLayoutModel,
  workspace: WorkspaceLayout
): WorkspaceLayoutViolation[] {
  const violations: WorkspaceLayoutViolation[] = []
  const breach = (rule: WorkspaceLayoutViolation['rule'], ids: string[], detail: string) =>
    violations.push({ rule, hostId: model.hostId, worktreeId: workspace.worktreeId, ids, detail })
  const tabIds = new Set(workspace.tabs.map((tab) => tab.id))
  const groupsByTab = new Map<string, string[]>()
  for (const group of workspace.groups) {
    if (group.tabOrder.length === 0) {
      breach('group_empty', [group.id], `group ${group.id} holds no tab`)
    }
    for (const tabId of group.tabOrder) {
      groupsByTab.set(tabId, [...(groupsByTab.get(tabId) ?? []), group.id])
      if (!tabIds.has(tabId)) {
        breach('group_lists_missing_tab', [group.id, tabId], `group ${group.id} lists ${tabId}`)
      }
    }
  }
  for (const tab of workspace.tabs) {
    const owners = groupsByTab.get(tab.id) ?? []
    if (owners.length === 0) {
      breach('tab_without_group', [tab.id], `tab ${tab.id} (${tab.kind}) is in no group`)
    } else if (owners.length > 1) {
      breach(
        'tab_in_two_groups',
        [tab.id, ...owners],
        `tab ${tab.id} is listed ${owners.length} times`
      )
    }
  }
  const treeIds = groupTreeIds(workspace.groupLayout)
  const groupIds = workspace.groups.map((group) => group.id)
  const treeMatches = workspace.groupLayout
    ? treeIds.length === groupIds.length &&
      new Set([...treeIds, ...groupIds]).size === groupIds.length
    : groupIds.length <= 1
  if (!treeMatches) {
    const detail = `group tree [${treeIds.join(', ')}] but groups [${groupIds.join(', ')}]`
    breach('group_tree_mismatch', treeIds, detail)
  }
  const paneIds = new Set(
    workspace.tabs.flatMap((tab) =>
      tab.kind === 'terminal' ? collectLayoutLeafIdsInOrder(tab.panes.root) : []
    )
  )
  const strays = Object.keys(workspace.leaves ?? {}).filter((leafId) => !paneIds.has(leafId))
  if (strays.length > 0) {
    breach('leaf_without_pane', strays, `pane data for panes no tab holds`)
  }
  return violations
}

function checkTabIds(model: WorkspaceLayoutModel): WorkspaceLayoutViolation[] {
  const homes = new Map<string, string[]>()
  for (const [key, workspace] of Object.entries(model.workspaces)) {
    workspace.tabs.forEach((tab) => homes.set(tab.id, [...(homes.get(tab.id) ?? []), key]))
  }
  return [...homes].flatMap(([tabId, keys]): WorkspaceLayoutViolation[] =>
    keys.length > 1
      ? [
          {
            rule: 'tab_in_two_places',
            hostId: model.hostId,
            ids: [tabId],
            detail: `tab ${tabId} listed ${keys.length} times: ${keys.join(', ')}`
          }
        ]
      : []
  )
}

function entities(model: WorkspaceLayoutModel): LayoutEntities {
  return {
    owners: paneOwners(model),
    groups: Object.values(model.workspaces).flatMap((workspace) => workspace.groups)
  }
}

/**
 * Every structural breach in the runtime's layout models. With `previous`, also flags ids that
 * changed for the same pane, tab or group across the update.
 */
export function checkWorkspaceLayoutModelRules(
  models: readonly WorkspaceLayoutModel[],
  previous?: readonly WorkspaceLayoutModel[]
): WorkspaceLayoutViolation[] {
  const violations = [
    ...checkPaneOwners(paneOwnerGroups(models, paneOwners)),
    ...models.flatMap(checkTabIds),
    ...models.flatMap((model) =>
      Object.values(model.workspaces).flatMap((workspace) => checkWorkspace(model, workspace))
    )
  ]
  for (const model of models) {
    const earlier = previous?.find((candidate) => candidate.hostId === model.hostId)
    if (earlier) {
      violations.push(...checkLayoutIdStability(model.hostId, entities(earlier), entities(model)))
    }
  }
  return violations
}
