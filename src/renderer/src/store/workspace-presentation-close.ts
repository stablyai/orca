import {
  structuredAgentSessionTargetForTab,
  structuredAgentSessionFocusOwner
} from '@/runtime/structured-agent-session-owner'
import {
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from '@/runtime/web-runtime-session-environment'
import {
  localStructuredSessionGeneration,
  isCurrentLocalStructuredSessionGeneration,
  localSourceAddressRevision,
  isCurrentLocalSourceAddress
} from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { workspacePresentationUserIntent } from '../../../shared/workspace-presentation-user-intent'
import { restoreWorkspacePresentationGroup } from '../../../shared/workspace-presentation-intent'
import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { AppState } from './types'
import {
  rawWorkspaceState,
  workspacePresentationFor,
  workspaceSourceOccurrence,
  workspaceSourceWrite,
  noteWorkspacePresentationChanges
} from './workspace-source-state'
import {
  prunePresentationLayout,
  workspaceEntityKey,
  tabPresentation,
  sourceTabPresentation,
  sourceTabEntity,
  workspacePresentationKey
} from '../../../shared/workspace-presentation'
export function workspaceSourceClaims(
  state: AppState,
  workspaceId: string,
  tab: AppState['unifiedTabsByWorktree'][string][number]
) {
  const raw = rawWorkspaceState(state)
  const saved = workspacePresentationFor(state, workspaceId)
  const ownSource = saved?.baseline.find(
    ({ source }) => source.workspaceId === tab.worktreeId
  )?.source
  const entity = workspaceEntityKey(
    ownSource
      ? sourceTabPresentation(tab, ownSource).entity
      : tabPresentation(tab, tab.executionHostId ?? saved?.anchor.hostId ?? 'local').entity
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

/** A failed close restores its own placement after the existing ordered live-source readback. */
export function failedWorkspaceTabCloseRestore(
  state: AppState,
  workspaceId: string,
  tabId: string,
  get: () => AppState,
  set: (patch: Partial<AppState>) => void
): (() => void) & { dispose: () => void } {
  const saved = workspacePresentationFor(state, workspaceId)
  const placement = saved?.tabs.find((tab) => tab.id === tabId)
  const intent = saved && workspacePresentationUserIntent(saved)
  const topology = intent?.topology
  const group = topology?.groups.find((group) => group.id === placement?.groupId)
  const source = workspaceSourceOccurrence(state, tabId, workspaceId)
  const target = source && structuredAgentSessionTargetForTab(state, source.tab)
  const owner =
    target && captureWebSessionIntentOwner(structuredAgentSessionFocusOwner(target).environmentId)
  const generation = localStructuredSessionGeneration()
  const addressRevision = localSourceAddressRevision()
  let settled = false
  const restore = () => {
    if (settled || !saved || !placement || !group || !intent || !topology) {
      return
    }
    settled = true
    intent.release()
    const currentState = get()
    const current = workspacePresentationFor(currentState, workspaceId)
    if (
      !current ||
      (owner && !matchesWebSessionIntentOwner(owner)) ||
      (target?.kind === 'local' &&
        (!isCurrentLocalStructuredSessionGeneration(generation) ||
          (source && !isCurrentLocalSourceAddress(source.source.workspaceId, addressRevision)))) ||
      current.displayWorkspaceId !== saved.displayWorkspaceId ||
      workspacePresentationKey(current.owner, current.anchor) !==
        workspacePresentationKey(saved.owner, saved.anchor) ||
      current.anchor.workspaceId !== saved.anchor.workspaceId ||
      (() => {
        const occurrence = workspaceSourceOccurrence(currentState, tabId, workspaceId)
        return (
          !occurrence ||
          workspaceEntityKey(sourceTabEntity(occurrence.tab, occurrence.source)) !==
            workspaceEntityKey(placement.entity)
        )
      })()
    ) {
      return
    }
    const untouched = (key: string): boolean => !intent.touched.has(key)
    const entity = workspaceEntityKey(placement.entity)
    const live = current.tabs.find((tab) => workspaceEntityKey(tab.entity) === entity)
    const tab = live ?? placement
    const canPlace =
      untouched(`tab:${tab.id}:groupId`) &&
      untouched('layout') &&
      untouched(`order:${group.id}`) &&
      untouched(`selection:${group.id}`) &&
      (!live || (untouched(`order:${live.groupId}`) && untouched(`selection:${live.groupId}`)))
    const restored = { ...tab }
    for (const field of [
      'customLabel',
      'color',
      'isPinned',
      'viewMode',
      'lastFocusedAt'
    ] as const) {
      if (
        untouched(`tab:${tab.id}:${field}`) &&
        (!live || live[field] === placement[field] || live[field] == null)
      ) {
        Object.assign(restored, { [field]: placement[field] })
      }
    }
    let groups = current.groups
    let layout = current.layout
    let activeGroupId = current.activeGroupId
    if (canPlace) {
      restored.groupId = group.id
      groups = current.groups
        .filter((entry) => entry.id !== group.id)
        .map((entry) => ({
          ...entry,
          tabOrder: entry.tabOrder.filter((id) => id !== tab.id),
          activeTabId:
            entry.activeTabId === tab.id
              ? (entry.tabOrder.find((id) => id !== tab.id) ?? null)
              : entry.activeTabId
        }))
      const existing = current.groups.find((entry) => entry.id === group.id)
      const order = (existing?.tabOrder ?? []).filter((id) => id !== tab.id)
      order.splice(Math.min(group.tabOrder.indexOf(placement.id), order.length), 0, tab.id)
      const restoredGroup = {
        ...group,
        ...existing,
        tabOrder: order,
        activeTabId: untouched(`selection:${group.id}`)
          ? group.activeTabId
          : (existing?.activeTabId ?? tab.id)
      }
      const following = topology.groups
        .slice(topology.groups.indexOf(group) + 1)
        .find((entry) => groups.some((candidate) => candidate.id === entry.id))
      groups.splice(
        following ? groups.findIndex((entry) => entry.id === following.id) : groups.length,
        0,
        restoredGroup
      )
      const original = new Set(
        topology.groups.filter((entry) => !entry.tabOrder.length).map((entry) => entry.id)
      )
      groups = groups.filter((entry) => entry.tabOrder.length || original.has(entry.id))
      const retained = new Set(
        groups
          .filter((entry) => entry.id !== group.id || entry.tabOrder.some((id) => id !== tab.id))
          .map((entry) => entry.id)
      )
      layout = restoreWorkspacePresentationGroup(
        topology.layout,
        prunePresentationLayout(current.layout, retained),
        group.id
      )
      if (untouched('selection') && topology.activeGroupId === group.id) {
        activeGroupId = group.id
      }
    } else if (!live) {
      return
    }
    const tabs = live
      ? current.tabs.map((entry) => (entry === live ? restored : entry))
      : [...current.tabs, restored]
    const document = { ...current, tabs, groups, layout, activeGroupId }
    const key = workspacePresentationKey(current.owner, current.anchor)
    const documents = editWorkspacePresentationDocuments(
      currentState.workspacePresentations ?? {},
      key,
      document
    )
    noteWorkspacePresentationChanges(documents, [key])
    set(workspaceSourceWrite({ workspacePresentations: documents }, { documents: [key] }))
  }
  return Object.assign(restore, {
    dispose: () => {
      settled = true
      intent?.release()
    }
  })
}

/** A real native close retracts every admitted contribution of that physical conversation. */
export function retireWorkspaceNativeClaims(
  state: AppState,
  workspaceId: string,
  tab: AppState['unifiedTabsByWorktree'][string][number]
): Partial<AppState> {
  const claims = workspaceSourceClaims(state, workspaceId, tab).filter(
    (source) => source.workspaceId !== tab.worktreeId
  )
  if (!claims.length) {
    return {}
  }
  const unifiedTabsByWorktree = { ...state.unifiedTabsByWorktree }
  const groupsByWorktree = { ...state.groupsByWorktree }
  const layoutByWorktree = { ...state.layoutByWorktree }
  const activeGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
  for (const source of claims) {
    const before = unifiedTabsByWorktree[source.workspaceId] ?? []
    const entity = workspaceEntityKey(sourceTabPresentation(tab, source).entity)
    const removed = new Set(
      before
        .filter(
          (candidate) =>
            workspaceEntityKey(sourceTabPresentation(candidate, source).entity) === entity
        )
        .map((candidate) => candidate.id)
    )
    unifiedTabsByWorktree[source.workspaceId] = before.filter(
      (candidate) => !removed.has(candidate.id)
    )
    const groups = (groupsByWorktree[source.workspaceId] ?? []).map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !removed.has(id))
      return {
        ...group,
        tabOrder,
        activeTabId:
          group.activeTabId && removed.has(group.activeTabId)
            ? (tabOrder[0] ?? null)
            : group.activeTabId,
        recentTabIds: group.recentTabIds?.filter((id) => !removed.has(id))
      }
    })
    const retained = groups.filter((group) => group.tabOrder.length)
    groupsByWorktree[source.workspaceId] = retained.length ? retained : groups.slice(0, 1)
    const ids = new Set(groupsByWorktree[source.workspaceId].map((group) => group.id))
    const layout = prunePresentationLayout(layoutByWorktree[source.workspaceId], ids)
    if (layout) {
      layoutByWorktree[source.workspaceId] = layout
    } else {
      delete layoutByWorktree[source.workspaceId]
    }
    if (!ids.has(activeGroupIdByWorktree[source.workspaceId])) {
      const next = groupsByWorktree[source.workspaceId][0]?.id
      if (next) {
        activeGroupIdByWorktree[source.workspaceId] = next
      } else {
        delete activeGroupIdByWorktree[source.workspaceId]
      }
    }
  }
  return { unifiedTabsByWorktree, groupsByWorktree, layoutByWorktree, activeGroupIdByWorktree }
}
