import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from '../store/types'
import { resetRuntimeMobileSyncProjectionCachesForTests } from './sync-runtime-graph'
import {
  getTerminalTabOwnershipIndex,
  graphState,
  resetRuntimeGraphSliceScanCaches
} from './sync-runtime-graph/graph-state'
import {
  buildMobileSessionAgentStatusByWorktree,
  getOpenFileIndexes
} from './sync-runtime-graph/mobile-session-inputs'
import { resetMobileSessionWorktreeIdCacheForTests } from './sync-runtime-graph/mobile-session-worktree-sources'
import { createTabKeyedRecordPartitioner } from './sync-runtime-graph/tab-keyed-record-partition'
import {
  getBrowserTabsByWorktree,
  getEditorDraftVersionByFileId
} from './sync-runtime-graph/sync-projections'
import { getMobileTerminalTheme } from './sync-runtime-graph/mobile-terminal-theme'
import type { MobileSessionPublicationInputs } from './sync-runtime-graph/types'

export const LEAF_ID = 'eeeeeeee-1111-4111-8111-111111111111'
export const DIRTY_WT = 'repo::/gate-dirty'
export const DIRTY_TAB = 'gate-dirty-term'
export const GATE_REPO = 'gate-repo'
export const GATE_INSTANCE = 'gate-instance-a'
export const GATE_FILE = '/gate/notes.md'
export const GATE_UNIFIED_TAB = 'gate-unified-editor'
export const GATE_WORKSPACE = 'gate-browser-workspace'
export const GATE_PAGE = 'gate-browser-page'

export function makeTab(id: string, worktreeId: string, title = 'Agent'): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    // Tab-wide launch evidence is what routes a launch draft onto a pane key; without an agent the
    // `launchDraftBucket` fingerprint field has nothing downstream to move.
    launchAgent: 'claude'
  }
}

export function makeStatusEntry(
  paneKey: string,
  state: AgentStatusEntry['state']
): AgentStatusEntry {
  return { state, prompt: '', updatedAt: 1, stateStartedAt: 1, paneKey, stateHistory: [] }
}

export function makeLayout(ptyId: string): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: ptyId }
  }
}

/**
 * The dirty worktree carries one live value for every fingerprint field, so deleting any single
 * comparison in `mobileSessionWorktreeSourceRefsEqual` leaves some mutation below undetected.
 */
function makeGateFixtureSlices(): Partial<AppState> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path reads only the row fields assigned here; a full Worktree is not constructible in a unit test.
  return {
    unifiedTabsByWorktree: {
      [DIRTY_WT]: [
        {
          id: GATE_UNIFIED_TAB,
          entityId: GATE_FILE,
          groupId: 'gate-unified-group',
          worktreeId: DIRTY_WT,
          contentType: 'editor',
          label: 'notes.md',
          customLabel: null,
          color: '#1155aa',
          sortOrder: 0,
          createdAt: 0
        }
      ]
    },
    openFiles: [
      {
        id: GATE_FILE,
        filePath: GATE_FILE,
        relativePath: 'notes.md',
        worktreeId: DIRTY_WT,
        language: 'markdown',
        isDirty: true,
        mode: 'edit'
      }
    ],
    editorDrafts: { [GATE_FILE]: '# notes' },
    nativeChatLaunchDraftByTabId: {
      [DIRTY_TAB]: {
        tabId: DIRTY_TAB,
        agent: 'claude',
        text: 'draft one',
        createdAt: 1,
        resolved: false
      }
    },
    browserTabsByWorktree: {
      [DIRTY_WT]: [
        {
          id: GATE_WORKSPACE,
          worktreeId: DIRTY_WT,
          activePageId: GATE_PAGE,
          pageIds: [GATE_PAGE],
          url: 'https://gate.example',
          title: 'Gate',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]
    },
    browserPagesByWorkspace: {
      [GATE_WORKSPACE]: [
        {
          id: GATE_PAGE,
          workspaceId: GATE_WORKSPACE,
          worktreeId: DIRTY_WT,
          url: 'https://gate.example/one',
          title: 'One',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]
    },
    browserCertificateFailuresByPageId: {
      [GATE_PAGE]: {
        challengeId: 'gate-challenge-a',
        browserPageId: GATE_PAGE,
        errorCode: -200,
        error: 'ERR_CERT_COMMON_NAME_INVALID',
        origin: 'https://gate.example',
        displayHost: 'gate.example',
        canProceed: true,
        observedAt: 1
      }
    },
    worktreesByRepo: {
      [GATE_REPO]: [
        {
          id: DIRTY_WT,
          instanceId: GATE_INSTANCE,
          hostId: 'local',
          repoId: GATE_REPO,
          path: '/gate-dirty',
          branch: 'main'
        }
      ]
    }
  } as unknown as Partial<AppState>
}

export function makeGateState(filler: number): { state: AppState } {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    // The second tab has no layout, pane title or draft, so only the ambiguity set can witness a
    // change of its ownership.
    [DIRTY_WT]: [makeTab(DIRTY_TAB, DIRTY_WT), makeTab('gate-bare-term', DIRTY_WT)]
  }
  const terminalLayoutsByTabId: AppState['terminalLayoutsByTabId'] = {
    [DIRTY_TAB]: makeLayout('pty-gate-dirty')
  }
  for (let index = 0; index < filler; index += 1) {
    const worktreeId = `repo::/gate-filler-${index}`
    tabsByWorktree[worktreeId] = [makeTab(`gate-filler-term-${index}`, worktreeId)]
    terminalLayoutsByTabId[`gate-filler-term-${index}`] = makeLayout(`pty-gate-filler-${index}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the publication path reads only the slices assigned here; a full AppState is not constructible in a unit test.
  const state = {
    tabsByWorktree,
    terminalLayoutsByTabId,
    runtimePaneTitlesByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    layoutByWorktree: {},
    tabBarOrderByWorktree: { [DIRTY_WT]: [DIRTY_TAB, 'gate-bare-term'] },
    // An active editor file is what makes the inputs builder consult the active-tab-type slices at
    // all; with none open that whole branch is unreachable and its fingerprint fields are inert.
    activeFileId: GATE_FILE,
    activeFileIdByWorktree: {},
    activeTabType: null,
    activeTabTypeByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabId: null,
    agentStatusByPaneKey: {
      [`${DIRTY_TAB}:${LEAF_ID}`]: makeStatusEntry(`${DIRTY_TAB}:${LEAF_ID}`, 'working')
    },
    folderWorkspaces: [],
    settings: { tabAutoGenerateTitle: false, theme: 'dark' },
    ...makeGateFixtureSlices()
  } as unknown as AppState
  return { state }
}

/** Every mutation below replaces slices of the same partial fixture; see `makeGateState`. */
export function patchGateState(state: AppState, patch: Partial<AppState>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a patch of the partial fixture is the same shape, and the publication path reads only the slices it assigns.
  return { ...state, ...patch } as AppState
}

export function withChangedStatus(state: AppState, nextState: AgentStatusEntry['state']): AppState {
  const paneKey = `${DIRTY_TAB}:${LEAF_ID}`
  return patchGateState(state, {
    agentStatusByPaneKey: { [paneKey]: makeStatusEntry(paneKey, nextState) }
  })
}

export function resetPublicationCaches(): void {
  graphState.mobileSessionSnapshotCacheByWorktree.clear()
  graphState.publishedMobileSessionSnapshotByWorktree.clear()
  resetRuntimeGraphSliceScanCaches()
  resetRuntimeMobileSyncProjectionCachesForTests()
  resetMobileSessionWorktreeIdCacheForTests()
}

export type GateSide = {
  state: AppState
  publication: MobileSessionPublicationInputs
}

const partitionLayouts =
  createTabKeyedRecordPartitioner<AppState['terminalLayoutsByTabId'][string]>()
const partitionTitles =
  createTabKeyedRecordPartitioner<AppState['runtimePaneTitlesByTabId'][string]>()
const partitionDrafts =
  createTabKeyedRecordPartitioner<NonNullable<AppState['nativeChatLaunchDraftByTabId']>[string]>()

/** The publication-wide inputs exactly as `buildMobileSessionTabSnapshots` derives them. */
export function gateSideOf(state: AppState): GateSide {
  const owners = getTerminalTabOwnershipIndex(state.tabsByWorktree)
  return {
    state,
    publication: {
      browserTabsByWorktree: getBrowserTabsByWorktree(state),
      openFileIndexes: getOpenFileIndexes(state.openFiles),
      editorDraftVersionByFileId: getEditorDraftVersionByFileId(state.editorDrafts),
      agentStatusByWorktreeId: buildMobileSessionAgentStatusByWorktree(
        state.agentStatusByPaneKey,
        state.tabsByWorktree
      ),
      terminalLayoutByWorktree: partitionLayouts(state.terminalLayoutsByTabId, owners),
      runtimePaneTitleByWorktree: partitionTitles(state.runtimePaneTitlesByTabId, owners),
      launchDraftByWorktree: partitionDrafts(state.nativeChatLaunchDraftByTabId, owners),
      generatedTitlesEnabled: state.settings?.tabAutoGenerateTitle === true,
      terminalTheme: getMobileTerminalTheme(state, false),
      ambiguousTabIds: owners.ambiguousTabIds
    }
  }
}
