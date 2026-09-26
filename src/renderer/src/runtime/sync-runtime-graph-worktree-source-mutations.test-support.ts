import type { AppState } from '../store/types'
import {
  DIRTY_TAB,
  DIRTY_WT,
  GATE_FILE,
  GATE_INSTANCE,
  GATE_PAGE,
  GATE_REPO,
  GATE_UNIFIED_TAB,
  GATE_WORKSPACE,
  makeLayout,
  makeTab,
  patchGateState,
  withChangedStatus
} from './sync-runtime-graph-worktree-source-gate.test-support'

/**
 * One store edit per field of `MobileSessionWorktreeSourceRefs`, applied to `makeGateState`.
 *
 * Each entry has to move both oracles: the published snapshot (so the gate can be caught serving
 * stale content) and `mobileSessionWorktreeSourceRefsEqual` (so deleting the field's comparison
 * makes the fingerprint claim an unchanged frame). A field with no entry here can be dropped from
 * the fingerprint with the whole suite green.
 */
export const mutations: { name: string; apply: (state: AppState) => AppState }[] = [
  {
    name: 'a terminal tab title',
    apply: (state) => ({
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [DIRTY_WT]: [makeTab(DIRTY_TAB, DIRTY_WT, 'Renamed')]
      }
    })
  },
  { name: 'an agent status', apply: (state) => withChangedStatus(state, 'waiting') },
  {
    name: 'a runtime pane title',
    apply: (state) => ({
      ...state,
      runtimePaneTitlesByTabId: { [DIRTY_TAB]: { 1: 'vim' } }
    })
  },
  {
    name: 'a saved terminal layout',
    apply: (state) =>
      patchGateState(state, {
        terminalLayoutsByTabId: { [DIRTY_TAB]: makeLayout('pty-gate-relayout') }
      })
  },
  {
    name: 'the active tab',
    apply: (state) => ({ ...state, activeTabId: DIRTY_TAB })
  },
  {
    // Split from the active-group edit below: one mutation moving both fields lets either
    // comparison be deleted while the other still fails the assertion.
    name: 'a tab group',
    apply: (state) => ({
      ...state,
      groupsByWorktree: {
        ...state.groupsByWorktree,
        [DIRTY_WT]: [
          {
            id: 'gate-group',
            worktreeId: DIRTY_WT,
            activeTabId: DIRTY_TAB,
            tabOrder: [DIRTY_TAB]
          }
        ]
      }
    })
  },
  {
    name: 'the active tab group',
    apply: (state) => ({
      ...state,
      activeGroupIdByWorktree: { ...state.activeGroupIdByWorktree, [DIRTY_WT]: 'gate-group' }
    })
  },
  {
    name: 'the tab bar order',
    apply: (state) => ({
      ...state,
      tabBarOrderByWorktree: {
        ...state.tabBarOrderByWorktree,
        [DIRTY_WT]: ['gate-bare-term', DIRTY_TAB]
      }
    })
  },
  {
    name: 'the tab group layout',
    apply: (state) =>
      patchGateState(state, {
        layoutByWorktree: { [DIRTY_WT]: { type: 'leaf', groupId: 'gate-group' } }
      })
  },
  {
    name: "the worktree's active file",
    apply: (state) =>
      patchGateState(state, {
        activeFileIdByWorktree: {
          ...state.activeFileIdByWorktree,
          [DIRTY_WT]: '/gate/elsewhere.md'
        }
      })
  },
  {
    name: 'the globally active file',
    apply: (state) => ({ ...state, activeFileId: '/gate/elsewhere.md' })
  },
  {
    name: "the worktree's active tab type",
    apply: (state) =>
      patchGateState(state, {
        activeTabTypeByWorktree: { ...state.activeTabTypeByWorktree, [DIRTY_WT]: 'editor' }
      })
  },
  {
    name: 'the globally active tab type',
    apply: (state) => ({ ...state, activeTabType: 'editor' })
  },
  {
    name: "the worktree's active browser workspace",
    apply: (state) =>
      patchGateState(state, {
        activeBrowserTabIdByWorktree: {
          ...state.activeBrowserTabIdByWorktree,
          [DIRTY_WT]: GATE_WORKSPACE
        }
      })
  },
  {
    name: 'a browser workspace title',
    apply: (state) =>
      patchGateState(state, {
        browserTabsByWorktree: {
          ...state.browserTabsByWorktree,
          [DIRTY_WT]: (state.browserTabsByWorktree[DIRTY_WT] ?? []).map((workspace) => ({
            ...workspace,
            title: 'Gate renamed'
          }))
        }
      })
  },
  {
    name: 'the generated-title setting',
    apply: (state) =>
      patchGateState(state, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's settings object is a partial one; only the terminal-theme and title fields are read here.
        settings: { ...state.settings, tabAutoGenerateTitle: true } as AppState['settings']
      })
  },
  {
    // Why a second settings edit: it moves `terminalTheme` while leaving `generatedTitlesEnabled`
    // alone, so neither settings-derived comparison can mask the other's deletion.
    name: 'a terminal color override',
    apply: (state) =>
      patchGateState(state, {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fixture's settings object is a partial one; only the terminal-theme and title fields are read here.
        settings: {
          ...state.settings,
          terminalColorOverrides: { background: '#102030' }
        } as AppState['settings']
      })
  },
  {
    name: 'another worktree claiming a tab with no tab-keyed records',
    apply: (state) => ({
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'repo::/gate-bare-claimant': [makeTab('gate-bare-term', 'repo::/gate-bare-claimant')]
      }
    })
  },
  {
    name: 'an open file',
    apply: (state) =>
      patchGateState(state, {
        openFiles: [
          ...state.openFiles,
          {
            id: '/gate/readme.md',
            filePath: '/gate/readme.md',
            relativePath: 'readme.md',
            worktreeId: DIRTY_WT,
            language: 'markdown',
            isDirty: false,
            mode: 'edit'
          }
        ]
      })
  },
  {
    name: 'an editor draft',
    apply: (state) => patchGateState(state, { editorDrafts: { [GATE_FILE]: '# notes, edited' } })
  },
  {
    name: 'a unified editor tab',
    apply: (state) => ({
      ...state,
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [DIRTY_WT]: (state.unifiedTabsByWorktree[DIRTY_WT] ?? []).map((tab) =>
          tab.id === GATE_UNIFIED_TAB ? { ...tab, color: '#aa3311' } : tab
        )
      }
    })
  },
  {
    name: 'a native chat launch draft',
    apply: (state) =>
      patchGateState(state, {
        nativeChatLaunchDraftByTabId: {
          [DIRTY_TAB]: {
            tabId: DIRTY_TAB,
            agent: 'claude',
            text: 'draft two',
            createdAt: 2,
            resolved: false
          }
        }
      })
  },
  {
    name: 'a browser page title',
    apply: (state) =>
      patchGateState(state, {
        browserPagesByWorkspace: {
          ...state.browserPagesByWorkspace,
          [GATE_WORKSPACE]: (state.browserPagesByWorkspace[GATE_WORKSPACE] ?? []).map((page) => ({
            ...page,
            title: 'Two'
          }))
        }
      })
  },
  {
    name: 'a browser certificate failure',
    apply: (state) =>
      patchGateState(state, {
        browserCertificateFailuresByPageId: Object.fromEntries(
          Object.entries(state.browserCertificateFailuresByPageId).map(([pageId, failure]) => [
            pageId,
            pageId === GATE_PAGE
              ? { ...failure, challengeId: 'gate-challenge-b', canProceed: false }
              : failure
          ])
        )
      })
  },
  {
    // STA-4343: the instance id disambiguates two hosts publishing the same bare worktree id, so a
    // stale one routes a mobile session at the wrong workspace.
    name: 'the worktree instance id',
    apply: (state) =>
      patchGateState(state, {
        worktreesByRepo: {
          ...state.worktreesByRepo,
          [GATE_REPO]: (state.worktreesByRepo[GATE_REPO] ?? []).map((worktree) => ({
            ...worktree,
            instanceId: `${GATE_INSTANCE}-moved`
          }))
        }
      })
  },
  {
    name: 'another worktree claiming this tab id',
    apply: (state) => ({
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        'repo::/gate-claimant': [makeTab(DIRTY_TAB, 'repo::/gate-claimant')]
      }
    })
  },
  {
    name: 'the worktree that owns a tab',
    apply: (state) => ({
      ...state,
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [DIRTY_WT]: [],
        'repo::/gate-filler-0': [
          makeTab('gate-filler-term-0', 'repo::/gate-filler-0'),
          makeTab(DIRTY_TAB, 'repo::/gate-filler-0')
        ]
      }
    })
  }
]
