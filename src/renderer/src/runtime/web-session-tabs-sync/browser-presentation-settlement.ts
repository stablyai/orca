import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { editWorkspacePresentationDocuments } from '../../../../shared/workspace-presentation-documents'
import {
  reduceWorkspacePresentation,
  restoreWorkspacePresentationGroup
} from '../../../../shared/workspace-presentation-intent'
import {
  composeWorkspacePresentation,
  reconcileWorkspacePresentation
} from '../../../../shared/workspace-presentation-reconcile'
import { sourceBaseline, workspacePresentationKey } from '../../../../shared/workspace-presentation'
import {
  noteWorkspacePresentationChanges,
  workspacePresentationFor
} from '@/store/workspace-source-state'
import type { WebSessionTabsSyncState } from './state'

/** Creation spends its placement once; subsequent frames cannot undo a user move. */
export function settleBrowserPresentation(
  state: WebSessionTabsSyncState,
  patch: Partial<WebSessionTabsSyncState>,
  workspaceId: string,
  placements: { tabId: string; groupId: string }[],
  activeTabId?: string | null
): Partial<WebSessionTabsSyncState> {
  const before = workspacePresentationFor(state, workspaceId)
  if (!before || !placements.length) {
    return {}
  }
  const key = workspacePresentationKey(before.owner, before.anchor)
  const saved = patch.workspacePresentations?.[key] ?? before
  const next = { ...state, ...patch }
  const session = {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: next.unifiedTabsByWorktree,
    tabGroups: next.groupsByWorktree,
    tabGroupLayouts: next.layoutByWorktree,
    activeGroupIdByWorktree: next.activeGroupIdByWorktree
  }
  const sources = saved.baseline.map(({ source }) => ({
    baseline: sourceBaseline(session, source),
    tabs: next.unifiedTabsByWorktree[source.workspaceId] ?? []
  }))
  const reconciled = reconcileWorkspacePresentation(
    saved,
    sources.map(({ baseline }) => baseline)
  )
  const view = composeWorkspacePresentation(reconciled, sources)
  const moves = new Map(
    placements
      .filter(
        (placement) =>
          !before.tabs.some((tab) => tab.id === placement.tabId) &&
          (saved.groups.some((group) => group.id === placement.groupId) ||
            view.groups.some((group) => group.id === placement.groupId))
      )
      .map((placement) => [placement.tabId, placement.groupId])
  )
  if (!moves.size) {
    return {}
  }
  const tabs = view.tabs.map((tab) =>
    moves.has(tab.id) ? { ...tab, groupId: moves.get(tab.id) ?? tab.groupId } : tab
  )
  let layout = view.layout
  const allGroups = [...view.groups]
  for (const groupId of new Set(moves.values())) {
    if (allGroups.some((group) => group.id === groupId)) {
      continue
    }
    const group = saved.groups.find((group) => group.id === groupId)
    if (group) {
      allGroups.push({ ...group, tabOrder: [], activeTabId: null })
      layout = restoreWorkspacePresentationGroup(saved.layout, layout, groupId)
    }
  }
  const groups = allGroups.map((group) => ({
    ...group,
    tabOrder: [
      ...group.tabOrder.filter((id) => !moves.has(id)),
      ...tabs.filter((tab) => moves.get(tab.id) === group.id).map((tab) => tab.id)
    ]
  }))
  const replacedSelection = saved.groups.find(
    (group) =>
      group.id === saved.activeGroupId &&
      group.activeTabId &&
      !tabs.some((tab) => tab.id === group.activeTabId)
  )
  const selectedTabId =
    activeTabId ?? tabs.find((tab) => moves.get(tab.id) === replacedSelection?.id)?.id
  const activeGroupId = selectedTabId ? moves.get(selectedTabId) : undefined
  const document = reduceWorkspacePresentation(reconciled, {
    type: 'layout',
    ...view,
    tabs,
    layout,
    groups: groups.map((group) =>
      activeGroupId === group.id ? { ...group, activeTabId: selectedTabId ?? null } : group
    ),
    activeGroupId: activeGroupId ?? view.activeGroupId
  })
  const documents = editWorkspacePresentationDocuments(
    next.workspacePresentations ?? {},
    key,
    document
  )
  noteWorkspacePresentationChanges(documents, [key])
  return { workspacePresentations: documents }
}
