import { hasWorkspacePresentationDocuments } from '../../../shared/workspace-presentation-documents'
import type { AppState } from './types'
import { WorkspacePresentationIndex } from './workspace-presentation-index'
import { deriveActiveSurfaceForWorktree } from './slices/tabs/tabs-surface'
import { rawStates, bindingIndexes, documentChanges } from './workspace-source-state'
import {
  isWorkspacePresentationKey,
  type WorkspacePresentationDocuments,
  type WorkspacePresentation
} from '../../../shared/workspace-presentation'
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

export function createWorkspaceCompositionView() {
  let index = new WorkspacePresentationIndex()
  let indexedDocuments: WorkspacePresentationDocuments | undefined
  const indexDocuments = (
    documents: WorkspacePresentationDocuments | undefined,
    keys?: readonly string[]
  ): void => {
    if (documents === indexedDocuments) {
      return
    }
    keys ??= documents ? documentChanges.get(documents) : undefined
    if (!keys) {
      index = new WorkspacePresentationIndex()
    }
    for (const key of keys ?? Object.keys(documents ?? {})) {
      const before = isWorkspacePresentationKey(key) ? indexedDocuments?.[key] : undefined
      const saved = isWorkspacePresentationKey(key) ? documents?.[key] : undefined
      if (
        keys &&
        before &&
        saved &&
        before.displayWorkspaceId === saved.displayWorkspaceId &&
        before.baseline.length === saved.baseline.length &&
        before.baseline.every(
          (entry, at) => entry.source.workspaceId === saved.baseline[at].source.workspaceId
        )
      ) {
        continue
      }
      if (before) {
        for (const id of [
          before.displayWorkspaceId,
          ...before.baseline.map(({ source }) => source.workspaceId)
        ]) {
          if (index.get(id) === key) {
            index = index.delete(id)
          }
        }
      }
      if (saved && isWorkspacePresentationKey(key)) {
        index = index.set(saved.displayWorkspaceId, key)
        for (const { source } of saved.baseline) {
          index = index.set(source.workspaceId, key)
        }
      }
    }
    indexedDocuments = documents
  }
  type Composed = ReturnType<typeof composeWorkspacePresentation> & {
    terminals: AppState['tabsByWorktree'][string]
    browsers: AppState['browserTabsByWorktree'][string]
  }
  const workspaceCache = new WeakMap<WorkspacePresentation, { rows: unknown[]; value: Composed }>()
  const workspace = (raw: AppState, saved: WorkspacePresentation): Composed => {
    const rows = saved.baseline.flatMap(({ source }) => [
      raw.unifiedTabsByWorktree[source.workspaceId],
      raw.tabsByWorktree[source.workspaceId],
      raw.browserTabsByWorktree[source.workspaceId]
    ])
    const old = workspaceCache.get(saved)
    if (old && rows.every((value, at) => value === old.rows[at])) {
      return old.value
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
    workspaceCache.set(saved, { rows, value })
    return value
  }
  const views = new WeakMap<AppState, AppState>()
  let previousRaw: AppState | undefined
  let projection: Partial<AppState> = {}
  let projectionInputs: unknown[] = []
  let surfaceInputs: unknown[] = []
  let activeSurface: Partial<AppState> = {}
  const project = (raw: AppState): AppState => {
    const known = views.get(raw)
    if (known) {
      return known
    }
    indexDocuments(raw.workspacePresentations)
    const bindingIndex = index
    const composedRows = new Map<WorkspacePresentation, Composed>()
    const composedRow = (saved: WorkspacePresentation): Composed => {
      let value = composedRows.get(saved)
      if (!value) {
        value = workspace(raw, saved)
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
    const inputs = [
      raw.workspacePresentations,
      raw.unifiedTabsByWorktree,
      raw.groupsByWorktree,
      raw.layoutByWorktree,
      raw.activeGroupIdByWorktree,
      raw.tabsByWorktree,
      raw.browserTabsByWorktree,
      raw.activeTabIdByWorktree,
      raw.activeFileIdByWorktree,
      raw.activeBrowserTabIdByWorktree,
      raw.activeTabTypeByWorktree
    ]
    if (!previousRaw || inputs.some((value, at) => value !== projectionInputs[at])) {
      projectionInputs = inputs
      projection = hasWorkspacePresentationDocuments(raw.workspacePresentations)
        ? {
            unifiedTabsByWorktree: record(raw.unifiedTabsByWorktree, (_saved, value) => value.tabs),
            groupsByWorktree: record(raw.groupsByWorktree, (_saved, value) => value.groups),
            layoutByWorktree: record(raw.layoutByWorktree, (_saved, value) => value.layout),
            activeGroupIdByWorktree: record(
              raw.activeGroupIdByWorktree,
              (_saved, value) => value.activeGroupId
            ),
            tabsByWorktree: record(raw.tabsByWorktree, (_saved, value) => value.terminals),
            browserTabsByWorktree: record(
              raw.browserTabsByWorktree,
              (_saved, value) => value.browsers
            ),
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
            activeBrowserTabIdByWorktree: record(
              raw.activeBrowserTabIdByWorktree,
              (saved, value) => {
                const group = value.groups.find((entry) => entry.id === value.activeGroupId)
                const tab = value.tabs.find((entry) => entry.id === group?.activeTabId)
                return tab?.contentType === 'browser'
                  ? tab.entityId
                  : (raw.activeBrowserTabIdByWorktree[saved.displayWorkspaceId] ??
                      (saved.baseline[0]
                        ? raw.activeBrowserTabIdByWorktree[saved.baseline[0].source.workspaceId]
                        : null))
              }
            )
          }
        : {}
    }
    const nextSurfaceInputs = [projection, raw.activeWorktreeId, raw.openFiles]
    if (nextSurfaceInputs.some((value, at) => value !== surfaceInputs[at])) {
      surfaceInputs = nextSurfaceInputs
      activeSurface =
        raw.activeWorktreeId && documentFor(raw.activeWorktreeId)
          ? deriveActiveSurfaceForWorktree({ ...raw, ...projection }, raw.activeWorktreeId)
          : {}
    }
    previousRaw = raw
    const view = { ...raw, ...projection, ...activeSurface }
    bindingIndexes.set(raw, bindingIndex)
    bindingIndexes.set(view, bindingIndex)
    views.set(raw, view)
    rawStates.set(view, raw)
    return view
  }

  return {
    project,
    indexDocuments,
    documentKey: (id: string) => index.get(id),
    acknowledgeSettlement: (documents: WorkspacePresentationDocuments | undefined) => {
      indexedDocuments = documents
    }
  }
}
