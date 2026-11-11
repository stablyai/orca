// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { singlePaneLayoutSnapshot } from '@/store/terminals/terminal-single-pane-layout'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'
import { useTerminalWatcherEffects } from '../../use-terminal-watcher-effects'
import { takePendingBackgroundTerminalWorktreeMount } from '../../terminal/background-terminal-worktree-mount'
import { synchronizeTerminalProviderSnapshotCapabilities } from '../../terminal/terminal-provider-snapshot-capability'
import { dispatchTerminalSideEffectBatch } from '../pty-transport/output/terminal-side-effect-facts-handler'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'

const WORKSPACE = 'repo1::/repo1/background'
const TAB = 'background-tab'
const FIRST_PTY = `${WORKSPACE}@@first`
const SECOND_PTY = `${WORKSPACE}@@second`
const FIRST_LEAF = '11111111-1111-4111-8111-111111111111'
const SECOND_LEAF = '22222222-2222-4222-8222-222222222222'
const initialState = useAppStore.getState()
const originalApi = window.api
const unsubs: (() => void)[] = []

afterEach(() => {
  cleanup()
  for (const unsubscribe of unsubs.splice(0)) {
    unsubscribe()
  }
  useAppStore.setState(initialState, true)
  window.api = originalApi
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('receives a new background split pane title and bell without mounting the workspace', async () => {
  vi.useFakeTimers()
  let createTerminal!: Parameters<Window['api']['ui']['onCreateTerminal']>[0]
  const subscribe = () => () => {}
  window.api = {
    ...originalApi,
    ui: {
      ...originalApi?.ui,
      onLaunchRecipe: subscribe,
      onCreateTerminal: (listener) => {
        createTerminal = listener
        return () => {}
      },
      onRequestTerminalTabMount: subscribe
    },
    pty: {
      ...originalApi?.pty,
      onData: subscribe,
      onReplay: subscribe,
      onExit: subscribe,
      onSideEffect: subscribe,
      getSideEffectSnapshot: async () => null,
      write: async () => {}
    },
    gh: { ...originalApi?.gh },
    settings: { ...originalApi?.settings, set: async () => createGlobalSettingsFixture() },
    worktrees: { ...originalApi?.worktrees, updateMeta: async () => null }
  }
  const tab = makeTab({ id: TAB, worktreeId: WORKSPACE, ptyId: FIRST_PTY })
  const seed = () =>
    useAppStore.setState({
      repos: [TEST_REPO],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: WORKSPACE, repoId: TEST_REPO.id })] },
      activeWorktreeId: null,
      activeView: 'terminal',
      tabsByWorktree: { [WORKSPACE]: [tab] },
      unifiedTabsByWorktree: {},
      ptyIdsByTabId: { [TAB]: [FIRST_PTY] },
      terminalLayoutsByTabId: { [TAB]: singlePaneLayoutSnapshot(FIRST_LEAF, FIRST_PTY) },
      runtimePaneTitlesByTabId: {},
      unreadTerminalTabs: {},
      unreadTerminalPanes: {}
    })
  seed()
  registerTerminalPresentationIpcBridge(unsubs)
  const split = {
    worktreeId: WORKSPACE,
    tabId: TAB,
    ptyId: SECOND_PTY,
    leafId: SECOND_LEAF,
    splitFromLeafId: FIRST_LEAF,
    splitDirection: 'horizontal' as const
  }

  // The public split asks for activation; replay it before the supported nonactivating team split.
  createTerminal({ ...split, activate: true })
  expect(useAppStore.getState().activeWorktreeId).toBe(WORKSPACE)
  expect(useAppStore.getState().terminalLayoutsByTabId[TAB].ptyIdsByLeafId).toEqual({
    [FIRST_LEAF]: FIRST_PTY,
    [SECOND_LEAF]: SECOND_PTY
  })
  seed()
  await synchronizeTerminalProviderSnapshotCapabilities([FIRST_PTY, SECOND_PTY], async (ids) =>
    ids.map((id) => ({ id, authoritative: true }))
  )
  const mountedWorktreeIdsRef = { current: new Set<string>() }
  const workspaceSurfaceIds = [WORKSPACE]
  const activationDeferredMountTabIdsByWorktreeRef = {
    current: new Map<string, ReadonlySet<string>>()
  }
  const measurableBackgroundWorktreeIdsRef = { current: new Set<string>() }
  const noTabs = new Set<string>()
  const getEffectiveLayoutForWorktree = () => undefined
  renderHook(() => {
    const tabsByWorktree = useAppStore((state) => state.tabsByWorktree)
    useTerminalWatcherEffects({
      ...useAppStore.getState(),
      tabsByWorktree,
      workspaceSurfaceIds,
      workspaceSurfaceIdSet: new Set(workspaceSurfaceIds),
      mountedWorktreeIdsRef,
      measurableBackgroundWorktreeIdsRef,
      activationDeferredMountTabIdsByWorktreeRef,
      getEffectiveLayoutForWorktree,
      activityTerminalPortals: [],
      effectiveParkedTerminalWorktreeIds: noTabs,
      evictionExemptTerminalTabIds: noTabs,
      pairedRuntimeParkingEnvironmentIds: noTabs,
      anyMountedWorktreeHasLayout: false,
      backgroundMountRevision: 0,
      renderedActiveWorktreeId: null,
      startupTerminalTabHold: null,
      hydrationSucceeded: true,
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true,
      terminalParkingEnabled: true,
      terminalSshParkingEnabled: true,
      terminalTitleSnapshotAuthorityEnabled: true,
      terminalProviderSnapshotCapabilityRevision: 0
    })
  })

  act(() =>
    dispatchTerminalSideEffectBatch({
      ptyId: FIRST_PTY,
      seq: 1,
      facts: [{ kind: 'title', normalizedTitle: 'First pane ready', rawTitle: 'First pane ready' }]
    })
  )
  expect(Object.values(useAppStore.getState().runtimePaneTitlesByTabId[TAB] ?? {})).toContain(
    'First pane ready'
  )

  act(() => createTerminal({ ...split, activate: false }))
  expect(useAppStore.getState().activeWorktreeId).toBeNull()
  expect(takePendingBackgroundTerminalWorktreeMount(WORKSPACE)).toBeNull()
  expect(mountedWorktreeIdsRef.current.has(WORKSPACE)).toBe(false)
  expect(useAppStore.getState().terminalLayoutsByTabId[TAB].ptyIdsByLeafId).toEqual({
    [FIRST_LEAF]: FIRST_PTY,
    [SECOND_LEAF]: SECOND_PTY
  })
  act(() =>
    dispatchTerminalSideEffectBatch({
      ptyId: SECOND_PTY,
      seq: 1,
      facts: [
        { kind: 'title', normalizedTitle: 'Second pane ready', rawTitle: 'Second pane ready' },
        { kind: 'bell' }
      ]
    })
  )
  expect(Object.values(useAppStore.getState().runtimePaneTitlesByTabId[TAB] ?? {})).toContain(
    'Second pane ready'
  )
  expect(useAppStore.getState().unreadTerminalTabs[TAB]).toBe('terminal-bell')
})
