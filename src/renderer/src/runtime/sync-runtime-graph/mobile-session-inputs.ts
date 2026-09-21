import type { AppState } from '@/store/types'
import { parsePaneKey, makePaneKey } from '../../../../shared/stable-pane-id'
import { nativeChatLaunchAgentForLeaf } from '../../components/native-chat/native-chat-leaf-routing'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import {
  EMPTY_NARROWED_BY_KEY,
  EMPTY_WORKTREE_BROWSER_WORKSPACES,
  EMPTY_WORKTREE_OPEN_FILE_IDS,
  EMPTY_WORKTREE_TAB_GROUPS,
  EMPTY_WORKTREE_TERMINAL_TABS,
  EMPTY_WORKTREE_UNIFIED_TABS,
  EMPTY_LAYOUT_BY_WORKTREE,
  graphState
} from './graph-state'
import type {
  MobileSessionAgentStatusByWorktree,
  MobileSessionPublicationInputs,
  MobileSessionWorktreeInputs,
  OpenFileIndexes
} from './types'
import { captureMountedTerminalSurfaces, narrowRecordByKeys } from './mobile-session-capture'
import {
  getRuntimeLeafIdsForTerminal,
  resolveMobileTabWideAgentHintLeafId
} from './mobile-session-surfaces'

export function getOpenFileIndexes(openFiles: AppState['openFiles']): OpenFileIndexes {
  if (graphState.cachedOpenFileIndexesSource === openFiles && graphState.cachedOpenFileIndexes) {
    return graphState.cachedOpenFileIndexes
  }
  const byWorktreeAndId = new Map<string, Map<string, AppState['openFiles'][number]>>()
  const idsByWorktree = new Map<string, string[]>()
  for (const file of openFiles) {
    let filesById = byWorktreeAndId.get(file.worktreeId)
    if (!filesById) {
      filesById = new Map()
      byWorktreeAndId.set(file.worktreeId, filesById)
    }
    let ids = idsByWorktree.get(file.worktreeId)
    if (!ids) {
      ids = []
      idsByWorktree.set(file.worktreeId, ids)
    }
    if (!filesById.has(file.id)) {
      filesById.set(file.id, file)
      ids.push(file.id)
    }
  }
  graphState.cachedOpenFileIndexesSource = openFiles
  graphState.cachedOpenFileIndexes = { byWorktreeAndId, idsByWorktree }
  return graphState.cachedOpenFileIndexes
}

export function buildMobileSessionAgentStatusByWorktree(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'],
  tabsByWorktree: AppState['tabsByWorktree']
): MobileSessionAgentStatusByWorktree {
  const byWorktreeId = new Map<string, Map<string, AppState['agentStatusByPaneKey'][string]>>()
  const paneKeys = Object.keys(agentStatusByPaneKey)
  if (paneKeys.length === 0) {
    return byWorktreeId
  }
  const worktreeIdByTabId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      worktreeIdByTabId.set(tab.id, worktreeId)
    }
  }
  for (const paneKey of paneKeys) {
    const tabId = parsePaneKey(paneKey)?.tabId
    const worktreeId = tabId === undefined ? undefined : worktreeIdByTabId.get(tabId)
    if (worktreeId === undefined) {
      continue
    }
    let bucket = byWorktreeId.get(worktreeId)
    if (!bucket) {
      bucket = new Map()
      byWorktreeId.set(worktreeId, bucket)
    }
    bucket.set(paneKey, agentStatusByPaneKey[paneKey])
  }
  return byWorktreeId
}

// Why: a bare id can name one workspace per host (STA-4343); with two owners no
// single identity is correct, so publish without one and let main fall back to
// its generation fence rather than blank the mobile session.
function resolveWorktreeInstanceId(state: AppState, worktreeId: string): string | undefined {
  const rows = getIndexedWorktreesById(state.worktreesByRepo ?? {}, worktreeId)
  return rows.length === 1 ? rows[0]?.instanceId : undefined
}

export function buildMobileSessionWorktreeInputs(
  state: AppState,
  worktreeId: string,
  publication: MobileSessionPublicationInputs,
  ambiguousTerminalTabIds: ReadonlySet<string>
): MobileSessionWorktreeInputs {
  // Legacy layout/title maps are keyed only by tab id. Omit ambiguous ids until
  // hydration repairs ownership instead of publishing one worktree's metadata for another.
  const sourceTerminalTabs = state.tabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TERMINAL_TABS
  // Preserve the source reference when there is nothing to filter; the mobile
  // snapshot cache uses this identity to avoid rebuilding on title ticks.
  const terminalTabs = sourceTerminalTabs.some((tab) => ambiguousTerminalTabIds.has(tab.id))
    ? sourceTerminalTabs.filter((tab) => !ambiguousTerminalTabIds.has(tab.id))
    : sourceTerminalTabs
  const terminalTabIds = terminalTabs.map((tab) => tab.id)
  const terminalLayoutByTabId = narrowRecordByKeys(state.terminalLayoutsByTabId, terminalTabIds)
  const mountedSurfaceCaptureByTabId = captureMountedTerminalSurfaces(
    terminalTabs,
    state.terminalLayoutsByTabId,
    worktreeId
  )
  const browserWorkspaces =
    publication.browserTabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_BROWSER_WORKSPACES
  const pagesByBrowserWorkspaceId = narrowRecordByKeys(
    state.browserPagesByWorkspace,
    browserWorkspaces.map((workspace) => workspace.id)
  )
  const browserPageIds: string[] = []
  for (const pages of pagesByBrowserWorkspaceId.values()) {
    for (const page of pages) {
      browserPageIds.push(page.id)
    }
  }
  const openFilesById = publication.openFileIndexes.byWorktreeAndId.get(worktreeId)
  const openFileIds =
    publication.openFileIndexes.idsByWorktree.get(worktreeId) ?? EMPTY_WORKTREE_OPEN_FILE_IDS
  const resolvedActiveFileId = state.activeFileIdByWorktree?.[worktreeId] ?? state.activeFileId
  const activeEditorFileId =
    resolvedActiveFileId && openFilesById?.has(resolvedActiveFileId) ? resolvedActiveFileId : null
  const activeTabId = state.activeTabId
  return {
    worktreeId,
    worktreeInstanceId: resolveWorktreeInstanceId(state, worktreeId),
    terminalTabs,
    browserWorkspaces,
    unifiedTabs: state.unifiedTabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_UNIFIED_TABS,
    groups: state.groupsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TAB_GROUPS,
    tabBarOrder: state.tabBarOrderByWorktree[worktreeId],
    activeGroupId: state.activeGroupIdByWorktree[worktreeId] ?? null,
    tabGroupLayout: (state.layoutByWorktree ?? EMPTY_LAYOUT_BY_WORKTREE)[worktreeId],
    openFilesById,
    openFileIds,
    terminalLayoutByTabId,
    paneTitlesByTabId: narrowRecordByKeys(state.runtimePaneTitlesByTabId, terminalTabIds),
    launchDraftByPaneKey: buildMobileLaunchDraftsByPaneKey({
      terminalTabs,
      terminalLayoutByTabId,
      mountedSurfaceCaptureByTabId,
      launchDraftByTabId: narrowRecordByKeys(state.nativeChatLaunchDraftByTabId, terminalTabIds)
    }),
    agentStatusByPaneKey:
      publication.agentStatusByWorktreeId.get(worktreeId) ?? EMPTY_NARROWED_BY_KEY,
    editorDraftVersionByFileId: narrowMapByKeys(
      publication.editorDraftVersionByFileId,
      openFileIds
    ),
    pagesByBrowserWorkspaceId,
    certificateFailureByBrowserPageId: narrowRecordByKeys(
      state.browserCertificateFailuresByPageId,
      browserPageIds
    ),
    activeEditorFileId,
    activeEditorTabType: activeEditorFileId
      ? (state.activeTabTypeByWorktree?.[worktreeId] ?? state.activeTabType)
      : null,
    activeTerminalTabId:
      activeTabId !== null && terminalTabIds.includes(activeTabId) ? activeTabId : null,
    activeBrowserWorkspaceId: state.activeBrowserTabIdByWorktree?.[worktreeId] ?? null,
    generatedTitlesEnabled: publication.generatedTitlesEnabled,
    terminalTheme: publication.terminalTheme,
    mountedSurfaceCaptureByTabId
  }
}

function narrowMapByKeys<T>(
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

export function buildMobileLaunchDraftsByPaneKey(args: {
  terminalTabs: AppState['tabsByWorktree'][string]
  terminalLayoutByTabId: MobileSessionWorktreeInputs['terminalLayoutByTabId']
  mountedSurfaceCaptureByTabId: MobileSessionWorktreeInputs['mountedSurfaceCaptureByTabId']
  launchDraftByTabId: ReadonlyMap<
    string,
    NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]
  >
}): MobileSessionWorktreeInputs['launchDraftByPaneKey'] {
  if (args.launchDraftByTabId.size === 0) {
    return EMPTY_NARROWED_BY_KEY
  }
  let draftsByPaneKey: Map<
    string,
    NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]
  > | null = null
  for (const terminal of args.terminalTabs) {
    const draft = args.launchDraftByTabId.get(terminal.id)
    if (!draft || draft.resolved) {
      continue
    }
    const capture = args.mountedSurfaceCaptureByTabId.get(terminal.id)
    const savedLayout = args.terminalLayoutByTabId.get(terminal.id)
    const leafIds = getRuntimeLeafIdsForTerminal(capture, savedLayout)
    const ownerLeafId = resolveMobileTabWideAgentHintLeafId(capture, savedLayout)
    const launchAgent = nativeChatLaunchAgentForLeaf({
      launchAgent: terminal.launchAgent,
      launchAgentLeafId: ownerLeafId,
      leafId: ownerLeafId,
      leafIds
    })
    if (!launchAgent || launchAgent !== draft.agent || !ownerLeafId) {
      continue
    }
    draftsByPaneKey ??= new Map()
    draftsByPaneKey.set(makePaneKey(terminal.id, ownerLeafId), draft)
  }
  return draftsByPaneKey ?? EMPTY_NARROWED_BY_KEY
}
