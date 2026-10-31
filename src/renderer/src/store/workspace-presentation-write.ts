import {
  normalizeWorkspaceViewKeys,
  workspaceViewRecordEdits
} from './workspace-presentation-record-edits'
import { editWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { AppState } from './types'
import { workspaceSourceSession, noteWorkspacePresentationChanges } from './workspace-source-state'
import {
  prunePresentationLayout,
  tabPresentation,
  sourceTabPresentation,
  sourceBaseline,
  workspaceEntityKey,
  type WorkspacePresentation
} from '../../../shared/workspace-presentation'
/** Only presentation and genuine content edits are writable; projected membership is never stored. */
export function applyViewWrite(raw: AppState, view: AppState, patch: Partial<AppState>): AppState {
  if (
    !raw.workspacePresentations ||
    ![
      'unifiedTabsByWorktree',
      'groupsByWorktree',
      'layoutByWorktree',
      'activeGroupIdByWorktree',
      'tabsByWorktree',
      'browserTabsByWorktree'
    ].some((key) => Object.hasOwn(patch, key))
  ) {
    return { ...raw, ...patch }
  }
  patch = normalizeWorkspaceViewKeys(raw, view, patch)
  const { next, affected } = workspaceViewRecordEdits(raw, view, patch)
  let documents = patch.workspacePresentations ?? raw.workspacePresentations
  const changedDocuments: string[] = []
  const changed = { ...view, ...patch }
  for (const [key, saved] of affected) {
    const id = saved.displayWorkspaceId
    const tabs = changed.unifiedTabsByWorktree[id] ?? []
    const structural =
      tabs !== view.unifiedTabsByWorktree[id] ||
      changed.groupsByWorktree[id] !== view.groupsByWorktree[id] ||
      changed.layoutByWorktree[id] !== view.layoutByWorktree[id] ||
      changed.activeGroupIdByWorktree[id] !== view.activeGroupIdByWorktree[id]
    const content =
      changed.tabsByWorktree[id] !== view.tabsByWorktree[id] ||
      changed.browserTabsByWorktree[id] !== view.browserTabsByWorktree[id]
    if (!structural && !content) {
      continue
    }
    let edited: WorkspacePresentation = {
      ...saved,
      tabs: tabs.map((tab) => tabPresentation(tab, tab.executionHostId ?? saved.anchor.hostId)),
      groups: changed.groupsByWorktree[id] ?? [],
      layout: changed.layoutByWorktree[id],
      activeGroupId: changed.activeGroupIdByWorktree[id]
    }
    // Strip the view bucket and return each content mutation to the bucket that actually owns it.
    const priorVisible = new Set((view.unifiedTabsByWorktree[id] ?? []).map((tab) => tab.id))
    const visible = new Map(
      tabs.map((tab) => [workspaceEntityKey(sourceTabPresentation(tab, saved.anchor).entity), tab])
    )
    const createdBySource = new Map<string, typeof tabs>()
    for (const tab of tabs) {
      if (priorVisible.has(tab.id)) {
        continue
      }
      const own = createdBySource.get(tab.worktreeId) ?? []
      own.push(tab)
      createdBySource.set(tab.worktreeId, own)
    }
    for (const { source } of saved.baseline) {
      const sourceId = source.workspaceId
      const old = raw.unifiedTabsByWorktree[sourceId] ?? []
      const oldEntities = new Set(
        old.map((tab) => workspaceEntityKey(sourceTabPresentation(tab, source).entity))
      )
      const retained = old.flatMap((before) => {
        const shown = visible.get(workspaceEntityKey(sourceTabPresentation(before, source).entity))
        return shown
          ? [
              {
                ...shown,
                id: before.id,
                worktreeId: sourceId,
                groupId: source.hostId === 'local' ? shown.groupId : before.groupId
              }
            ]
          : []
      })
      const created = (createdBySource.get(sourceId) ?? [])
        .filter(
          (tab) => !oldEntities.has(workspaceEntityKey(sourceTabPresentation(tab, source).entity))
        )
        .map((tab) => ({
          ...tab,
          groupId:
            source.hostId === 'local'
              ? tab.groupId
              : (raw.groupsByWorktree[sourceId]?.find((group) => group.id === tab.groupId)?.id ??
                raw.activeGroupIdByWorktree[sourceId] ??
                raw.groupsByWorktree[sourceId]?.[0]?.id ??
                tab.groupId)
        }))
      next.unifiedTabsByWorktree[sourceId] = [...retained, ...created]
      if (source.hostId === 'local') {
        const own = new Set(next.unifiedTabsByWorktree[sourceId].map((tab) => tab.id))
        const restricted = edited.groups
          .map((group) => ({
            ...group,
            worktreeId: sourceId,
            tabOrder: group.tabOrder.filter((tabId) => own.has(tabId)),
            activeTabId: group.activeTabId && own.has(group.activeTabId) ? group.activeTabId : null,
            recentTabIds: group.recentTabIds?.filter((tabId) => own.has(tabId))
          }))
          .filter((group) => group.tabOrder.length)
        next.groupsByWorktree[sourceId] = restricted
        const layout = prunePresentationLayout(
          edited.layout,
          new Set(restricted.map((group) => group.id))
        )
        if (layout) {
          next.layoutByWorktree[sourceId] = layout
        } else {
          delete next.layoutByWorktree[sourceId]
        }
        const active =
          restricted.find((group) => group.id === edited.activeGroupId) ?? restricted[0]
        if (active) {
          next.activeGroupIdByWorktree[sourceId] = active.id
        } else {
          delete next.activeGroupIdByWorktree[sourceId]
        }
      } else {
        next.groupsByWorktree[sourceId] = raw.groupsByWorktree[sourceId] ?? []
        if (raw.layoutByWorktree[sourceId]) {
          next.layoutByWorktree[sourceId] = raw.layoutByWorktree[sourceId]
        }
        next.activeGroupIdByWorktree[sourceId] = raw.activeGroupIdByWorktree[sourceId]
      }
      if (patch.tabsByWorktree) {
        const requested = patch.tabsByWorktree[id] ?? []
        const oldIds = new Set((raw.tabsByWorktree[sourceId] ?? []).map((tab) => tab.id))
        next.tabsByWorktree[sourceId] = requested
          .filter((tab) => oldIds.has(tab.id) || tab.worktreeId === sourceId)
          .map((tab) => ({ ...tab, worktreeId: sourceId }))
      } else {
        next.tabsByWorktree[sourceId] = raw.tabsByWorktree[sourceId] ?? []
      }
      if (patch.browserTabsByWorktree) {
        const before = new Set((raw.browserTabsByWorktree[sourceId] ?? []).map((tab) => tab.id))
        next.browserTabsByWorktree[sourceId] = (patch.browserTabsByWorktree[id] ?? []).filter(
          (tab) => before.has(tab.id) || tab.worktreeId === sourceId
        )
      } else {
        next.browserTabsByWorktree[sourceId] = raw.browserTabsByWorktree[sourceId] ?? []
      }
      // Remote source topology is not a client presentation group namespace.
    }
    if (structural) {
      const session = workspaceSourceSession(next)
      edited = {
        ...edited,
        baseline: saved.baseline.map(({ source }) => sourceBaseline(session, source))
      }
      documents = editWorkspacePresentationDocuments(documents, key, edited)
      changedDocuments.push(key)
    }
  }
  if (changedDocuments.length) {
    noteWorkspacePresentationChanges(documents, changedDocuments)
  }
  next.workspacePresentations = documents
  return next
}
