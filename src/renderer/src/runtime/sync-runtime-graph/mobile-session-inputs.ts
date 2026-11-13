import {
  pendingTabRevision,
  pendingEntityWorkspaceIds
} from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { editorPlacementIndex } from '@/store/slices/editor/tabs/workspace-editor-files'
import { runtimeEnvironmentIdForWorkspaceOwner } from '@/lib/workspace/ownership/resolve-owner'
import { hostSessionTabIdsByLocalTabForWorktree } from '../web-session-tabs-sync/tracking-mappings'
import type { AppState } from '@/store/types'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { nativeChatLaunchAgentForLeaf } from '../../components/native-chat/pane/routing/native-chat-leaf-routing'
import { getIndexedWorktreesById } from '@/store/slices/worktrees/listing/worktree-catalog-index'
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
  MobileSessionPublicationInputs,
  MobileSessionWorktreeInputs,
  OpenFileIndexes
} from './types'
import { captureMountedTerminalSurfaces, narrowRecordByKeys } from './mobile-session-capture'
import {
  getRuntimeLeafIdsForTerminal,
  resolveMobileTabWideAgentHintLeafId
} from './mobile-session-surfaces'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'

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

type PlacementOpenFileIndexes = OpenFileIndexes & { crossPlacedWorkspaces: ReadonlySet<string> }
const placementFileIndexes = new WeakMap<
  AppState['unifiedTabsByWorktree'],
  WeakMap<OpenFileIndexes, { revision: number; projection: PlacementOpenFileIndexes }>
>()

/** Preserve legacy tabless publication, excluding only content placed exclusively elsewhere. */
export function excludeCrossPlacedEditorFiles(
  indexes: OpenFileIndexes,
  tabs: AppState['unifiedTabsByWorktree']
): PlacementOpenFileIndexes {
  let byFiles = placementFileIndexes.get(tabs)
  const cached = byFiles?.get(indexes)
  const revision = pendingTabRevision()
  if (cached?.revision === revision) {
    return cached.projection
  }
  byFiles ??= new WeakMap()
  placementFileIndexes.set(tabs, byFiles)
  const placements = editorPlacementIndex(tabs).workspacesByEntityId
  const crossPlacedWorkspaces = new Set<string>()
  let result: PlacementOpenFileIndexes = { ...indexes, crossPlacedWorkspaces }
  for (const [owner, files] of indexes.byWorktreeAndId) {
    const excluded = [...files.keys()].filter((id) => {
      const workspaces = new Set([...(placements.get(id) ?? []), ...pendingEntityWorkspaceIds(id)])
      for (const workspaceId of workspaces) {
        if (workspaceId !== owner && !indexes.byWorktreeAndId.get(workspaceId)?.has(id)) {
          crossPlacedWorkspaces.add(workspaceId)
        }
      }
      return workspaces.size > 0 && !workspaces.has(owner)
    })
    if (!excluded.length) {
      continue
    }
    if (result.byWorktreeAndId === indexes.byWorktreeAndId) {
      result = {
        byWorktreeAndId: new Map(indexes.byWorktreeAndId),
        idsByWorktree: new Map(indexes.idsByWorktree),
        crossPlacedWorkspaces
      }
    }
    const remaining = new Map(files)
    for (const id of excluded) {
      remaining.delete(id)
    }
    result.byWorktreeAndId.set(owner, remaining)
    result.idsByWorktree.set(owner, [...remaining.keys()])
  }
  byFiles.set(indexes, { revision, projection: result })
  return result
}

// Bare IDs collide across hosts (STA-4343); ambiguous ownership omits identity so main uses generation fences rather than blanks mobile.
function resolveWorktreeInstanceId(state: AppState, worktreeId: string): string | undefined {
  const rows = getIndexedWorktreesById(selectWorktreesByRepo(state) ?? {}, worktreeId)
  return rows.length === 1 ? rows[0]?.instanceId : undefined
}

export function buildMobileSessionWorktreeInputs(
  state: AppState,
  worktreeId: string,
  publication: MobileSessionPublicationInputs,
  ambiguousTerminalTabIds: ReadonlySet<string>
): MobileSessionWorktreeInputs {
  // Legacy tab-ID maps cannot distinguish twins; omit ambiguous entries until hydration repairs ownership.
  const sourceTerminalTabs = state.tabsByWorktree[worktreeId] ?? EMPTY_WORKTREE_TERMINAL_TABS
  // Keep unfiltered source identity so title ticks reuse mobile snapshot cache.
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
  const owner = runtimeEnvironmentIdForWorkspaceOwner(state, { workspaceId: worktreeId })
  return {
    worktreeId,
    hostTabIds:
      owner.kind === 'resolved'
        ? hostSessionTabIdsByLocalTabForWorktree(owner.environmentId ?? 'local', worktreeId)
        : EMPTY_NARROWED_BY_KEY,
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
