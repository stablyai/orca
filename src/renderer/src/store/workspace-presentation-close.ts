import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { AppState } from './types'
import {
  rawWorkspaceState,
  workspacePresentationFor,
  workspaceSourceTab,
  workspaceSourceWrite,
  noteWorkspacePresentationChanges
} from './workspace-source-state'
import {
  prunePresentationLayout,
  workspaceEntityKey,
  tabPresentation,
  sourceTabPresentation,
  isWorkspacePresentationKey,
  type WorkspacePresentation
} from '../../../shared/workspace-presentation'
export function workspaceSourceClaims(
  state: AppState,
  workspaceId: string,
  tab: AppState['unifiedTabsByWorktree'][string][number]
) {
  const raw = rawWorkspaceState(state)
  const saved = workspacePresentationFor(state, workspaceId)
  const entity = workspaceEntityKey(
    tabPresentation(tab, tab.executionHostId ?? saved?.anchor.hostId ?? 'local').entity
  )
  const sources = saved?.baseline.map(({ source }) => source) ?? [
    { hostId: tab.executionHostId ?? 'local', workspaceId: tab.worktreeId }
  ]
  return sources.filter((source) =>
    (raw.unifiedTabsByWorktree[source.workspaceId] ?? []).some(
      (candidate) => workspaceEntityKey(sourceTabPresentation(candidate, source).entity) === entity
    )
  )
}

function restoreGroupPlacement(
  original: WorkspacePresentation['layout'],
  current: WorkspacePresentation['layout'],
  groupId: string
): WorkspacePresentation['layout'] {
  const contains = (node: WorkspacePresentation['layout'], id: string): boolean =>
    Boolean(
      node &&
      (node.type === 'leaf'
        ? node.groupId === id
        : contains(node.first, id) || contains(node.second, id))
    )
  if (contains(current, groupId)) {
    return current
  }
  const leaf = { type: 'leaf' as const, groupId }
  if (!current) {
    return leaf
  }
  const parent = (node: WorkspacePresentation['layout']): WorkspacePresentation['layout'] => {
    if (!node || node.type === 'leaf') {
      return undefined
    }
    if (
      (node.first.type === 'leaf' && node.first.groupId === groupId) ||
      (node.second.type === 'leaf' && node.second.groupId === groupId)
    ) {
      return node
    }
    return parent(node.first) ?? parent(node.second)
  }
  const previous = parent(original)
  if (previous?.type === 'split') {
    const sibling =
      previous.first.type === 'leaf' && previous.first.groupId === groupId
        ? previous.second
        : previous.first
    const anchor = (node: typeof sibling): string | undefined =>
      node.type === 'leaf'
        ? contains(current, node.groupId)
          ? node.groupId
          : undefined
        : (anchor(node.first) ?? anchor(node.second))
    const id = anchor(sibling)
    if (id) {
      const insert = (node: NonNullable<typeof current>): NonNullable<typeof current> =>
        node.type === 'leaf'
          ? node.groupId === id
            ? {
                ...previous,
                first:
                  previous.first.type === 'leaf' && previous.first.groupId === groupId
                    ? leaf
                    : node,
                second:
                  previous.first.type === 'leaf' && previous.first.groupId === groupId ? node : leaf
              }
            : node
          : { ...node, first: insert(node.first), second: insert(node.second) }
      return insert(current)
    }
  }
  return { type: 'split', direction: 'horizontal', first: current, second: leaf }
}

/** A failed close restores its own placement after the existing ordered live-source readback. */
export function failedWorkspaceTabCloseRestore(
  state: AppState,
  workspaceId: string,
  tabId: string,
  get: () => AppState,
  set: (patch: Partial<AppState>) => void
): () => void {
  const saved = workspacePresentationFor(state, workspaceId)
  const placement = saved?.tabs.find((tab) => tab.id === tabId)
  const group = saved?.groups.find((group) => group.id === placement?.groupId)
  return () => {
    if (!saved || !placement || !group) {
      return
    }
    const currentState = get()
    const current = workspacePresentationFor(currentState, workspaceId)
    if (!current || !workspaceSourceTab(currentState, tabId, workspaceId)) {
      return
    }
    const live = current.tabs.find(
      (tab) => workspaceEntityKey(tab.entity) === workspaceEntityKey(placement.entity)
    )
    if (!live) {
      return
    }
    let groups = current.groups
      .filter((entry) => entry.id !== group.id)
      .map((entry) => ({
        ...entry,
        tabOrder: entry.tabOrder.filter((id) => id !== live.id),
        activeTabId:
          entry.activeTabId === live.id
            ? (entry.tabOrder.find((id) => id !== live.id) ?? null)
            : entry.activeTabId
      }))
    const existing = current.groups.find((entry) => entry.id === group.id)
    const restoredGroup = existing
      ? { ...existing, tabOrder: [...new Set([...existing.tabOrder, live.id])] }
      : { ...group, tabOrder: [live.id], activeTabId: live.id }
    const following = saved.groups
      .slice(saved.groups.indexOf(group) + 1)
      .find((entry) => groups.some((candidate) => candidate.id === entry.id))
    const at = following ? groups.findIndex((entry) => entry.id === following.id) : groups.length
    groups.splice(at, 0, restoredGroup)
    const originalGroupIds = new Set(saved.groups.map((entry) => entry.id))
    groups = groups.filter((entry) => entry.tabOrder.length || originalGroupIds.has(entry.id))
    const tabs = current.tabs.map((tab) => (tab === live ? placement : tab))
    const retainedGroups = new Set(
      groups
        .filter((entry) => entry.id !== group.id || entry.tabOrder.some((id) => id !== live.id))
        .map((entry) => entry.id)
    )
    const layout = restoreGroupPlacement(
      saved.layout,
      prunePresentationLayout(current.layout, retainedGroups),
      group.id
    )
    const document = { ...current, tabs, groups, layout }
    const key = Object.entries(currentState.workspacePresentations ?? {}).find(
      ([, value]) => value === current
    )?.[0]
    if (key && isWorkspacePresentationKey(key)) {
      const documents = editWorkspacePresentationDocuments(
        currentState.workspacePresentations ?? {},
        key,
        document
      )
      noteWorkspacePresentationChanges(documents, [key])
      set(workspaceSourceWrite({ workspacePresentations: documents }, { documents: [key] }))
    }
  }
}
