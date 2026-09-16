import {
  collectLeafIdsInOrder,
  serializePaneTree
} from '@/components/terminal-pane/layout-serialization'
import type { AppState } from '@/store/types'
import type {
  RegisteredTerminalTab,
  MobileSessionWorktreeInputs,
  MountedTerminalSurfaceCapture
} from './types'
import { EMPTY_NARROWED_BY_KEY, findRegisteredTerminalTab, jsonContentEquals } from './graph-state'
import { isTerminalLeafId } from '../../../../shared/stable-pane-id'

export function narrowRecordByKeys<T>(
  source: Record<string, T> | undefined,
  keys: readonly string[]
): ReadonlyMap<string, T> {
  if (!source || keys.length === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let narrowed: Map<string, T> | null = null
  for (const key of keys) {
    const value = source[key]
    if (value === undefined) {
      continue
    }
    narrowed ??= new Map<string, T>()
    narrowed.set(key, value)
  }
  return narrowed ?? EMPTY_NARROWED_BY_KEY
}

export function narrowMapByKeys<T>(
  source: ReadonlyMap<string, T>,
  keys: readonly string[]
): ReadonlyMap<string, T> {
  if (source.size === 0 || keys.length === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let narrowed: Map<string, T> | null = null
  for (const key of keys) {
    if (!source.has(key)) {
      continue
    }
    narrowed ??= new Map<string, T>()
    narrowed.set(key, source.get(key) as T)
  }
  return narrowed ?? EMPTY_NARROWED_BY_KEY
}

export function captureMountedTerminalSurfaces(
  terminalTabs: AppState['tabsByWorktree'][string],
  terminalLayoutsByTabId: AppState['terminalLayoutsByTabId'],
  worktreeId: string
): ReadonlyMap<string, MountedTerminalSurfaceCapture> {
  let captures: Map<string, MountedTerminalSurfaceCapture> | null = null
  for (const tab of terminalTabs) {
    const registered = findRegisteredTerminalTab(tab.id, worktreeId)?.tab
    if (!registered) {
      continue
    }
    captures ??= new Map()
    captures.set(tab.id, captureMountedTerminalSurface(registered, terminalLayoutsByTabId[tab.id]))
  }
  return captures ?? EMPTY_NARROWED_BY_KEY
}

function captureMountedTerminalSurface(
  registered: RegisteredTerminalTab,
  savedLayout: AppState['terminalLayoutsByTabId'][string] | undefined
): MountedTerminalSurfaceCapture {
  const manager = registered.getManager()
  const paneLeafIds = manager?.getPanes().map((pane) => pane.leafId) ?? []
  const activePane = manager?.getActivePane() ?? null
  const firstChild = registered.getContainer()?.firstElementChild
  // Mirrors getRuntimeLeafIdsForTerminal so captured pane ids cover every resolved leaf.
  const effectiveLeafIds =
    paneLeafIds.length > 0
      ? paneLeafIds
      : collectLeafIdsInOrder(savedLayout?.root).filter(isTerminalLeafId)
  const numericPaneIdByLeafId = new Map<string, number | null>()
  const ptyIdByNumericPaneId = new Map<number, string | null>()
  for (const leafId of effectiveLeafIds) {
    const numericPaneId = manager?.getNumericIdForLeaf(leafId) ?? null
    numericPaneIdByLeafId.set(leafId, numericPaneId)
    if (numericPaneId !== null) {
      ptyIdByNumericPaneId.set(numericPaneId, registered.getPtyIdForPane(numericPaneId))
    }
  }
  return {
    paneLeafIds,
    hasLiveActivePane: activePane !== null,
    liveActiveLeafId: activePane !== null ? (manager?.getLeafId(activePane.id) ?? null) : null,
    liveLayoutRoot: serializePaneTree(
      typeof HTMLElement !== 'undefined' && firstChild instanceof HTMLElement ? firstChild : null
    ),
    numericPaneIdByLeafId,
    ptyIdByNumericPaneId,
    tabWideAgentHintLeafId: registered.getTabWideAgentHintLeafId()
  }
}

function narrowedEntriesEqual<K, T>(a: ReadonlyMap<K, T>, b: ReadonlyMap<K, T>): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [key, value] of a) {
    if (b.get(key) !== value) {
      return false
    }
  }
  return true
}

function mountedTerminalSurfaceCaptureEquals(
  a: MountedTerminalSurfaceCapture,
  b: MountedTerminalSurfaceCapture
): boolean {
  return (
    a.hasLiveActivePane === b.hasLiveActivePane &&
    a.liveActiveLeafId === b.liveActiveLeafId &&
    a.paneLeafIds.length === b.paneLeafIds.length &&
    a.paneLeafIds.every((leafId, index) => b.paneLeafIds[index] === leafId) &&
    narrowedEntriesEqual(a.numericPaneIdByLeafId, b.numericPaneIdByLeafId) &&
    narrowedEntriesEqual(a.ptyIdByNumericPaneId, b.ptyIdByNumericPaneId) &&
    a.tabWideAgentHintLeafId === b.tabWideAgentHintLeafId &&
    // Serialization allocates a fresh tree per capture, so compare its content.
    jsonContentEquals(a.liveLayoutRoot, b.liveLayoutRoot)
  )
}

export function mountedSurfaceCapturesEqual(
  a: ReadonlyMap<string, MountedTerminalSurfaceCapture>,
  b: ReadonlyMap<string, MountedTerminalSurfaceCapture>
): boolean {
  if (a === b) {
    return true
  }
  if (a.size !== b.size) {
    return false
  }
  for (const [tabId, capture] of a) {
    const other = b.get(tabId)
    if (!other || !mountedTerminalSurfaceCaptureEquals(capture, other)) {
      return false
    }
  }
  return true
}

export function canReuseMobileSessionSnapshot(
  previous: MobileSessionWorktreeInputs,
  next: MobileSessionWorktreeInputs
): boolean {
  return (
    previous.worktreeId === next.worktreeId &&
    previous.worktreeInstanceId === next.worktreeInstanceId &&
    previous.terminalTabs === next.terminalTabs &&
    previous.browserWorkspaces === next.browserWorkspaces &&
    previous.unifiedTabs === next.unifiedTabs &&
    previous.groups === next.groups &&
    previous.tabBarOrder === next.tabBarOrder &&
    previous.activeGroupId === next.activeGroupId &&
    previous.tabGroupLayout === next.tabGroupLayout &&
    previous.openFilesById === next.openFilesById &&
    previous.openFileIds === next.openFileIds &&
    previous.activeEditorFileId === next.activeEditorFileId &&
    previous.activeEditorTabType === next.activeEditorTabType &&
    previous.activeTerminalTabId === next.activeTerminalTabId &&
    previous.activeBrowserWorkspaceId === next.activeBrowserWorkspaceId &&
    previous.generatedTitlesEnabled === next.generatedTitlesEnabled &&
    previous.terminalTheme === next.terminalTheme &&
    narrowedEntriesEqual(previous.terminalLayoutByTabId, next.terminalLayoutByTabId) &&
    narrowedEntriesEqual(previous.paneTitlesByTabId, next.paneTitlesByTabId) &&
    narrowedEntriesEqual(previous.launchDraftByPaneKey, next.launchDraftByPaneKey) &&
    narrowedEntriesEqual(previous.agentStatusByPaneKey, next.agentStatusByPaneKey) &&
    narrowedEntriesEqual(previous.editorDraftVersionByFileId, next.editorDraftVersionByFileId) &&
    narrowedEntriesEqual(previous.pagesByBrowserWorkspaceId, next.pagesByBrowserWorkspaceId) &&
    narrowedEntriesEqual(
      previous.certificateFailureByBrowserPageId,
      next.certificateFailureByBrowserPageId
    ) &&
    mountedSurfaceCapturesEqual(
      previous.mountedSurfaceCaptureByTabId,
      next.mountedSurfaceCaptureByTabId
    )
  )
}
