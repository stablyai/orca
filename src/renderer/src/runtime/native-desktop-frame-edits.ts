import type { Tab } from '../../../shared/tab-types'
import { toVisibleTabType } from '../../../shared/tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { pickStoredFields } from '../../../shared/workspace-layout/stored-record-fields'
import { patchStoredSession } from '../../../shared/workspace-layout/workspace-layout-record-patch'
import { preserveConcurrentTabGroupOrder } from '../../../shared/desktop-window-tab-order'
import type { LayoutFrameSlices } from '../store/workspace-layout-frame-slices'
import type { LayoutFrameStoreState } from '../store/workspace-layout-frame-store-patch'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import type { AppState } from '../store/types'
import { withHeldTabsAsDrawn } from '../store/workspace-layout-frame-held-tabs'
import { isDirtyEditorBufferSide } from '../store/slices/editor/buffers/editor-buffer-join'

export function nativeDesktopFrameEdits(
  initial: LayoutFrameStoreState,
  target: RuntimeClientTarget
) {
  return !ORCA_LAYOUT_OWNER_IS_MAIN &&
    target.kind === 'local' &&
    typeof window !== 'undefined' &&
    window.__ORCA_NATIVE_WINDOW_ID__
    ? createNativeDesktopFrameEdits(initial)
    : undefined
}

const TAB_LAYOUT_FIELDS = [
  'id',
  'entityId',
  'groupId',
  'contentType',
  'customLabel',
  'color',
  'sortOrder',
  'isPreview',
  'isPinned',
  'viewMode'
] as const satisfies readonly (keyof Tab)[]

function snapshot(
  state: Pick<
    LayoutFrameStoreState,
    'unifiedTabsByWorktree' | 'groupsByWorktree' | 'layoutByWorktree'
  >,
  keys: readonly string[]
): WorkspaceSessionState {
  return {
    activeRepoId: null,
    activeWorktreeId: null,
    activeTabId: null,
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    unifiedTabs: Object.fromEntries(
      keys.map((key) => [
        key,
        (state.unifiedTabsByWorktree[key] ?? []).map((tab) => ({
          ...tab,
          label: '',
          generatedLabel: undefined,
          aiVaultTitle: undefined,
          quickCommandLabel: undefined,
          lastFocusedAt: undefined
        }))
      ])
    ),
    tabGroups: Object.fromEntries(
      keys.map((key) => [
        key,
        (state.groupsByWorktree[key] ?? []).map((group) => ({
          ...group,
          activeTabId: null,
          recentTabIds: undefined
        }))
      ])
    ),
    tabGroupLayouts: Object.fromEntries(
      keys.flatMap((key) =>
        state.layoutByWorktree[key] ? [[key, state.layoutByWorktree[key]]] : []
      )
    )
  }
}

export function createNativeDesktopFrameEdits(initial: LayoutFrameStoreState) {
  let before = snapshot(initial, Object.keys(initial.unifiedTabsByWorktree))
  return (
    state: LayoutFrameStoreState & Partial<Pick<AppState, 'editorDrafts'>>,
    built: LayoutFrameSlices,
    keys: readonly string[]
  ): LayoutFrameSlices => {
    const current = snapshot(state, keys)
    const incoming = snapshot(built, keys)
    const previous = {
      ...before,
      unifiedTabs: Object.fromEntries(keys.map((key) => [key, before.unifiedTabs?.[key] ?? []])),
      tabGroups: Object.fromEntries(keys.map((key) => [key, before.tabGroups?.[key] ?? []])),
      tabGroupLayouts: Object.fromEntries(
        keys.flatMap((key) =>
          before.tabGroupLayouts?.[key] ? [[key, before.tabGroupLayouts[key]]] : []
        )
      )
    }
    const merged = preserveConcurrentTabGroupOrder(
      incoming,
      previous,
      current,
      patchStoredSession(incoming, previous, current)
    )
    before = {
      ...before,
      unifiedTabs: { ...before.unifiedTabs, ...incoming.unifiedTabs },
      tabGroups: { ...before.tabGroups, ...incoming.tabGroups },
      tabGroupLayouts: { ...before.tabGroupLayouts, ...incoming.tabGroupLayouts }
    }
    const next = {
      ...built,
      unifiedTabsByWorktree: { ...built.unifiedTabsByWorktree },
      groupsByWorktree: { ...built.groupsByWorktree },
      layoutByWorktree: { ...built.layoutByWorktree },
      tabsByWorktree: { ...built.tabsByWorktree },
      browserTabsByWorktree: { ...built.browserTabsByWorktree },
      browserPagesByWorkspace: { ...built.browserPagesByWorkspace },
      terminalLayoutsByTabId: { ...built.terminalLayoutsByTabId }
    }
    for (const key of keys) {
      const main = new Map(built.unifiedTabsByWorktree[key]?.map((tab) => [tab.id, tab]))
      const local = new Map(state.unifiedTabsByWorktree[key]?.map((tab) => [tab.id, tab]))
      const tabs = (merged.unifiedTabs?.[key] ?? []).flatMap((tab): Tab[] => {
        const base = main.get(tab.id) ?? local.get(tab.id)
        return base ? [{ ...base, ...pickStoredFields(tab, TAB_LAYOUT_FIELDS) }] : []
      })
      next.unifiedTabsByWorktree[key] = tabs
      const added = tabs.filter((tab) => !main.has(tab.id))
      for (const tab of added) {
        if (tab.contentType === 'terminal' && state.terminalLayoutsByTabId[tab.entityId]) {
          next.terminalLayoutsByTabId[tab.entityId] = state.terminalLayoutsByTabId[tab.entityId]
        }
        if (tab.contentType === 'browser') {
          const browser = state.browserTabsByWorktree[key]?.find((row) => row.id === tab.entityId)
          if (browser) {
            next.browserTabsByWorktree[key] = [
              ...(next.browserTabsByWorktree[key] ?? []).filter((row) => row.id !== browser.id),
              browser
            ]
            next.browserPagesByWorkspace[browser.id] =
              state.browserPagesByWorkspace[browser.id] ?? []
          }
        }
      }
      const groups = new Map(
        [...(state.groupsByWorktree[key] ?? []), ...(built.groupsByWorktree[key] ?? [])].map(
          (group) => [group.id, group]
        )
      )
      next.groupsByWorktree[key] = (merged.tabGroups?.[key] ?? []).map((group) => ({
        ...group,
        ...groups.get(group.id),
        tabOrder: group.tabOrder
      }))
      if (merged.tabGroupLayouts?.[key]) {
        next.layoutByWorktree[key] = merged.tabGroupLayouts[key]
      }
      const terminalProps = new Map(
        tabs.filter((tab) => tab.contentType === 'terminal').map((tab) => [tab.entityId, tab])
      )
      const rows = new Map(
        [...(state.tabsByWorktree[key] ?? []), ...(built.tabsByWorktree[key] ?? [])].map((row) => [
          row.id,
          row
        ])
      )
      next.tabsByWorktree[key] = [...terminalProps].flatMap(([id, tab]) => {
        const row = rows.get(id)
        if (!row) {
          return []
        }
        const mainTab = tab ? main.get(tab.id) : undefined
        if (
          !mainTab ||
          stableJson(pickStoredFields(tab, TAB_LAYOUT_FIELDS)) ===
            stableJson(pickStoredFields(mainTab, TAB_LAYOUT_FIELDS))
        ) {
          return [row]
        }
        return [
          {
            ...row,
            customTitle: tab.customLabel,
            color: tab.color,
            sortOrder: tab.sortOrder,
            isPinned: tab.isPinned,
            viewMode: tab.viewMode
          }
        ]
      })
    }
    next.openFiles = built.openFiles.filter(
      (file) =>
        !built.unifiedTabsByWorktree[file.worktreeId]?.some((tab) => tab.entityId === file.id) ||
        next.unifiedTabsByWorktree[file.worktreeId]?.some((tab) => tab.entityId === file.id)
    )
    const dirtyFiles = state.openFiles.filter(
      (file) =>
        isDirtyEditorBufferSide({ record: file, draft: state.editorDrafts?.[file.id] }) &&
        state.unifiedTabsByWorktree[file.worktreeId]?.some(
          (tab) =>
            tab.entityId === file.id &&
            !next.unifiedTabsByWorktree[file.worktreeId]?.some((incoming) => incoming.id === tab.id)
        )
    )
    const holdsDirtyFile = (workspace: string, id: string): boolean =>
      dirtyFiles.some(
        (file) =>
          file.worktreeId === workspace &&
          (file.id === id ||
            state.unifiedTabsByWorktree[workspace]?.some(
              (tab) => tab.id === id && tab.entityId === file.id
            ))
      )
    const retained = withHeldTabsAsDrawn(state, next, keys, {
      isTabHeld: holdsDirtyFile,
      keepsInMainGroups: holdsDirtyFile,
      isGroupLayoutHeld: () => false
    })
    for (const key of keys) {
      const active = state.groupsByWorktree[key]?.find(
        (group) => group.id === state.activeGroupIdByWorktree[key]
      )?.activeTabId
      const tab = retained.unifiedTabsByWorktree[key]?.find((entry) => entry.id === active)
      const file = tab && state.openFiles.find((entry) => entry.id === tab.entityId)
      if (
        !tab ||
        !file ||
        !isDirtyEditorBufferSide({ record: file, draft: state.editorDrafts?.[file.id] })
      ) {
        continue
      }
      retained.groupsByWorktree = {
        ...retained.groupsByWorktree,
        [key]: retained.groupsByWorktree[key]!.map((group) =>
          group.id === tab.groupId ? { ...group, activeTabId: tab.id } : group
        )
      }
      retained.activeGroupIdByWorktree = { ...retained.activeGroupIdByWorktree, [key]: tab.groupId }
      retained.activeFileIdByWorktree = { ...retained.activeFileIdByWorktree, [key]: file.id }
      retained.activeTabTypeByWorktree = {
        ...retained.activeTabTypeByWorktree,
        [key]: toVisibleTabType(tab.contentType)
      }
    }
    return retained
  }
}
