import type { AppState } from './types'
import { ImmutableInputCache, absentImmutableInput } from '../../../shared/immutable-input-cache'
import { hasWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { WorkspacePresentation } from '../../../shared/workspace-presentation'
import type { WorkspacePresentationIndex } from './workspace-presentation-index'
import { composeWorkspacePresentation } from '../../../shared/workspace-presentation-reconcile'
function uniqueContentRows<Row extends { id: string }>(rows: Row[]): Row[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.id)) {
      return false
    }
    seen.add(row.id)
    return true
  })
}

type Composed = ReturnType<typeof composeWorkspacePresentation> & {
  terminals: AppState['tabsByWorktree'][string]
  browsers: AppState['browserTabsByWorktree'][string]
}
export type ProjectionState = Pick<
  AppState,
  | 'workspacePresentations'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'tabsByWorktree'
  | 'browserTabsByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
>
const workspaceCache = new ImmutableInputCache<Composed>()
export const composedWorkspace = (raw: ProjectionState, saved: WorkspacePresentation): Composed => {
  const rows = saved.baseline.flatMap(({ source }) => [
    raw.unifiedTabsByWorktree[source.workspaceId] ?? absentImmutableInput,
    raw.tabsByWorktree[source.workspaceId] ?? absentImmutableInput,
    raw.browserTabsByWorktree[source.workspaceId] ?? absentImmutableInput
  ])
  const inputs = [saved, ...rows]
  const old = workspaceCache.get(inputs, 'workspace')
  if (old) {
    return old
  }
  const composed = composeWorkspacePresentation(
    saved,
    saved.baseline.map((baseline) => ({
      baseline,
      tabs: raw.unifiedTabsByWorktree[baseline.source.workspaceId] ?? []
    }))
  )
  const value = {
    ...composed,
    terminals: uniqueContentRows(
      [...saved.baseline]
        .sort(
          (a, b) =>
            Number(b.source.workspaceId === saved.displayWorkspaceId) -
            Number(a.source.workspaceId === saved.displayWorkspaceId)
        )
        .flatMap(({ source }) => raw.tabsByWorktree[source.workspaceId] ?? [])
    ),
    browsers: uniqueContentRows(
      [...saved.baseline]
        .sort(
          (a, b) =>
            Number(b.source.workspaceId === saved.displayWorkspaceId) -
            Number(a.source.workspaceId === saved.displayWorkspaceId)
        )
        .flatMap(({ source }) => raw.browserTabsByWorktree[source.workspaceId] ?? [])
    )
  }
  workspaceCache.set(inputs, 'workspace', value)
  return value
}
export const buildWorkspaceProjection = (
  raw: ProjectionState,
  bindingIndex: WorkspacePresentationIndex
): Partial<AppState> => {
  const composedRows = new Map<WorkspacePresentation, Composed>()
  const composedRow = (saved: WorkspacePresentation): Composed => {
    let value = composedRows.get(saved)
    if (!value) {
      value = composedWorkspace(raw, saved)
      composedRows.set(saved, value)
    }
    return value
  }
  const documentFor = (id: string): WorkspacePresentation | undefined => {
    const key = bindingIndex.get(id)
    return key ? raw.workspacePresentations?.[key] : undefined
  }
  const record = <T>(
    source: Record<string, T>,
    row: (saved: WorkspacePresentation, value: Composed) => T | undefined
  ): Record<string, T> => {
    const read = (id: string): T | undefined => {
      const saved = documentFor(id)
      return saved ? row(saved, composedRow(saved)) : source[id]
    }
    return new Proxy(source, {
      get: (target, key, receiver) =>
        typeof key === 'string' && key !== 'toJSON'
          ? read(key)
          : Reflect.get(target, key, receiver),
      ownKeys: () =>
        [
          ...new Set([
            ...Object.keys(source),
            ...Object.values(raw.workspacePresentations ?? {}).flatMap((saved) =>
              saved ? [saved.displayWorkspaceId] : []
            )
          ])
        ].filter((id) => {
          const saved = documentFor(id)
          return (!saved || saved.displayWorkspaceId === id) && read(id) !== undefined
        }),
      getOwnPropertyDescriptor: (_target, key) =>
        typeof key === 'string' &&
        (!documentFor(key) || documentFor(key)?.displayWorkspaceId === key) &&
        read(key) !== undefined
          ? { configurable: true, enumerable: true, writable: false, value: read(key) }
          : undefined
    })
  }
  return hasWorkspacePresentationDocuments(raw.workspacePresentations)
    ? {
        unifiedTabsByWorktree: record(raw.unifiedTabsByWorktree, (_saved, value) => value.tabs),
        groupsByWorktree: record(raw.groupsByWorktree, (_saved, value) => value.groups),
        layoutByWorktree: record(raw.layoutByWorktree, (_saved, value) => value.layout),
        activeGroupIdByWorktree: record(
          raw.activeGroupIdByWorktree,
          (_saved, value) => value.activeGroupId
        ),
        tabsByWorktree: record(raw.tabsByWorktree, (_saved, value) => value.terminals),
        browserTabsByWorktree: record(raw.browserTabsByWorktree, (_saved, value) => value.browsers),
        activeTabIdByWorktree: record(raw.activeTabIdByWorktree, (saved, value) => {
          const group = value.groups.find((entry) => entry.id === value.activeGroupId)
          const tab = value.tabs.find((entry) => entry.id === group?.activeTabId)
          return tab?.contentType === 'terminal'
            ? tab.entityId
            : (raw.activeTabIdByWorktree[saved.displayWorkspaceId] ??
                (saved.baseline[0]
                  ? raw.activeTabIdByWorktree[saved.baseline[0].source.workspaceId]
                  : null))
        }),
        activeFileIdByWorktree: record(raw.activeFileIdByWorktree, (saved, value) => {
          const group = value.groups.find((entry) => entry.id === value.activeGroupId)
          const tab = value.tabs.find((entry) => entry.id === group?.activeTabId)
          return tab?.contentType === 'editor'
            ? tab.entityId
            : (raw.activeFileIdByWorktree[saved.displayWorkspaceId] ??
                (saved.baseline[0]
                  ? raw.activeFileIdByWorktree[saved.baseline[0].source.workspaceId]
                  : null))
        }),
        activeBrowserTabIdByWorktree: record(raw.activeBrowserTabIdByWorktree, (saved, value) => {
          const group = value.groups.find((entry) => entry.id === value.activeGroupId)
          const tab = value.tabs.find((entry) => entry.id === group?.activeTabId)
          return tab?.contentType === 'browser'
            ? tab.entityId
            : (raw.activeBrowserTabIdByWorktree[saved.displayWorkspaceId] ??
                (saved.baseline[0]
                  ? raw.activeBrowserTabIdByWorktree[saved.baseline[0].source.workspaceId]
                  : null))
        })
      }
    : {}
}
