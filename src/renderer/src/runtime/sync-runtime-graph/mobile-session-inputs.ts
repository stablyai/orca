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
  getMobileSessionAgentStatusCache,
  getTerminalTabOwnershipIndex,
  graphState,
  setMobileSessionAgentStatusCache
} from './graph-state'
import type {
  MobileSessionAgentStatusByWorktree,
  MobileSessionPublicationInputs,
  MobileSessionWorktreeInputs,
  OpenFileIndexes
} from './types'
import {
  captureMountedTerminalSurfaces,
  narrowedEntriesEqual,
  narrowMapByKeys,
  narrowRecordByKeys
} from './mobile-session-capture'
import {
  getRuntimeLeafIdsForTerminal,
  resolveMobileTabWideAgentHintLeafId
} from './mobile-session-surfaces'
import { tabKeyedRecordBucket } from './tab-keyed-record-partition'

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

/**
 * Memoized on both source slices: the tab->worktree map it rebuilds is proportional to every tab
 * in the store, yet one OSC frame replaces only `agentStatusByPaneKey`. Both slices are
 * copy-on-write, so an unchanged pair of references cannot hide a changed grouping.
 *
 * Unchanged worktrees keep their previous bucket object. One status frame then leaves every other
 * worktree's bucket reference-equal, which is what lets the publication loop skip it.
 */
export function buildMobileSessionAgentStatusByWorktree(
  agentStatusByPaneKey: AppState['agentStatusByPaneKey'],
  tabsByWorktree: AppState['tabsByWorktree']
): MobileSessionAgentStatusByWorktree {
  const cached = getMobileSessionAgentStatusCache()
  if (cached?.agentStatusSource === agentStatusByPaneKey && cached.tabsSource === tabsByWorktree) {
    return cached.byWorktreeId
  }
  const built = new Map<string, Map<string, AppState['agentStatusByPaneKey'][string]>>()
  // Ambiguous tab ids are absent from the index: the snapshot builders drop those terminals, so a
  // bucket entry for one could only mislabel another worktree's pane.
  const { worktreeIdByTabId } = getTerminalTabOwnershipIndex(tabsByWorktree)
  for (const paneKey of Object.keys(agentStatusByPaneKey)) {
    const tabId = parsePaneKey(paneKey)?.tabId
    const worktreeId = tabId === undefined ? undefined : worktreeIdByTabId.get(tabId)
    if (worktreeId === undefined) {
      continue
    }
    let bucket = built.get(worktreeId)
    if (!bucket) {
      bucket = new Map()
      built.set(worktreeId, bucket)
    }
    bucket.set(paneKey, agentStatusByPaneKey[paneKey])
  }
  const byWorktreeId = new Map<
    string,
    ReadonlyMap<string, AppState['agentStatusByPaneKey'][string]>
  >(built)
  for (const [worktreeId, bucket] of built) {
    const previousBucket = cached?.byWorktreeId.get(worktreeId)
    if (previousBucket && narrowedEntriesEqual(previousBucket, bucket)) {
      byWorktreeId.set(worktreeId, previousBucket)
    }
  }
  setMobileSessionAgentStatusCache({
    agentStatusSource: agentStatusByPaneKey,
    tabsSource: tabsByWorktree,
    byWorktreeId
  })
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
  publication: MobileSessionPublicationInputs
): MobileSessionWorktreeInputs {
  const ambiguousTerminalTabIds = publication.ambiguousTabIds
  // Legacy layout/title maps are keyed only by tab id. Omit ambiguous ids until
  // hydration repairs ownership instead of publishing one worktree's metadata for another.
  const sourceTerminalTabs = state.tabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TERMINAL_TABS
  // Preserve the source reference when there is nothing to filter; the mobile
  // snapshot cache uses this identity to avoid rebuilding on title ticks.
  const terminalTabs = sourceTerminalTabs.some((tab) => ambiguousTerminalTabIds.has(tab.id))
    ? sourceTerminalTabs.filter((tab) => !ambiguousTerminalTabIds.has(tab.id))
    : sourceTerminalTabs
  // Tab-keyed records arrive pre-grouped by owning worktree: narrowing them here cost one scan per
  // worktree per publication, and the bucket identity is what lets an unchanged worktree be skipped.
  const terminalLayoutByTabId = tabKeyedRecordBucket(
    publication.terminalLayoutByWorktree,
    worktreeId
  )
  const mountedSurfaceCaptureByTabId = captureMountedTerminalSurfaces(
    terminalTabs,
    terminalLayoutByTabId,
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
    paneTitlesByTabId: tabKeyedRecordBucket(publication.runtimePaneTitleByWorktree, worktreeId),
    launchDraftByPaneKey: buildMobileLaunchDraftsByPaneKey({
      terminalTabs,
      terminalLayoutByTabId,
      mountedSurfaceCaptureByTabId,
      launchDraftByTabId: tabKeyedRecordBucket(publication.launchDraftByWorktree, worktreeId)
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
      activeTabId !== null && terminalTabs.some((tab) => tab.id === activeTabId)
        ? activeTabId
        : null,
    activeBrowserWorkspaceId: state.activeBrowserTabIdByWorktree?.[worktreeId] ?? null,
    generatedTitlesEnabled: publication.generatedTitlesEnabled,
    terminalTheme: publication.terminalTheme,
    mountedSurfaceCaptureByTabId
  }
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
