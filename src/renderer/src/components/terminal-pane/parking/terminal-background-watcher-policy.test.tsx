// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { singlePaneLayoutSnapshot } from '@/store/terminals/terminal-single-pane-layout'
import { replaceMapEntries } from '@/store/keyed-record-transitions'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/rpc/testing/runtime-compatibility-test-fixture'
import { useTerminalWatcherEffects } from '../../use-terminal-watcher-effects'
import { synchronizeTerminalProviderSnapshotCapabilities } from '../../terminal/terminal-provider-snapshot-capability'
import { dispatchTerminalSideEffectBatch } from '../pty-transport/output/terminal-side-effect-facts-handler'
import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { ActivityTerminalPortalTarget } from '../../activity/activity-terminal-portal'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/constants'

const WORKSPACE = 'repo1::/repo1/background-policy'
const TAB = 'background-policy-tab'
const LEAF = '11111111-1111-4111-8111-111111111111'
const initialState = useAppStore.getState()
const originalApi = window.api

beforeEach(() => {
  vi.useFakeTimers()
  const subscribe = () => () => {}
  window.api = {
    ...originalApi,
    pty: {
      ...originalApi?.pty,
      onData: subscribe,
      onReplay: subscribe,
      onExit: subscribe,
      onSideEffect: subscribe,
      getSideEffectSnapshot: async () => null,
      write: async () => {}
    },
    settings: { ...originalApi?.settings, set: async () => createGlobalSettingsFixture() },
    worktrees: { ...originalApi?.worktrees, updateMeta: async () => null }
  }
})

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  window.api = originalApi
  vi.clearAllTimers()
  vi.useRealTimers()
})

function watchBackgroundTab(
  ptyId: string,
  activityTerminalPortals: ActivityTerminalPortalTarget[] = [],
  initialWorkspaceSurfaceIds = [WORKSPACE],
  worktreeId = WORKSPACE
) {
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: WORKSPACE, repoId: TEST_REPO.id })] },
    activeWorktreeId: null,
    activeView: 'terminal',
    settings: createGlobalSettingsFixture({ terminalSshViewParking: false }),
    tabsByWorktree: { [worktreeId]: [makeTab({ id: TAB, worktreeId, ptyId })] },
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: { [TAB]: [ptyId] },
    terminalLayoutsByTabId: { [TAB]: singlePaneLayoutSnapshot(LEAF, ptyId) },
    runtimePaneTitlesByTabId: {},
    runtimeStatusByEnvironmentId: new Map(),
    unreadTerminalTabs: {},
    unreadTerminalPanes: {}
  })
  const mountedWorktreeIdsRef = { current: new Set<string>() }
  const measurableBackgroundWorktreeIdsRef = { current: new Set<string>() }
  const activationDeferredMountTabIdsByWorktreeRef = {
    current: new Map<string, ReadonlySet<string>>()
  }
  const noTabs = new Set<string>()
  const getEffectiveLayoutForWorktree = () => undefined
  return renderHook(
    ({ workspaceSurfaceIds }) => {
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
        activityTerminalPortals,
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
    },
    { initialProps: { workspaceSurfaceIds: initialWorkspaceSurfaceIds } }
  )
}

function emitTitleAndBell(ptyId: string, seq: number, title: string): void {
  act(() =>
    dispatchTerminalSideEffectBatch({
      ptyId,
      seq,
      facts: [{ kind: 'title', normalizedTitle: title, rawTitle: title }, { kind: 'bell' }]
    })
  )
}

function clearAttention(): void {
  act(() => useAppStore.setState({ unreadTerminalTabs: {}, unreadTerminalPanes: {} }))
}

function expectUnwatched(title: string): void {
  expect(Object.values(useAppStore.getState().runtimePaneTitlesByTabId[TAB] ?? {})).not.toContain(
    title
  )
  expect(useAppStore.getState().unreadTerminalTabs[TAB]).toBeUndefined()
}

function expectWatched(title: string): void {
  expect(Object.values(useAppStore.getState().runtimePaneTitlesByTabId[TAB] ?? {})).toContain(title)
  expect(useAppStore.getState().unreadTerminalTabs[TAB]).toBe('terminal-bell')
}

it('starts a never-mounted watcher only after host snapshot coverage resolves', async () => {
  const ptyId = `${WORKSPACE}@@unresolved`
  watchBackgroundTab(ptyId)
  emitTitleAndBell(ptyId, 1, 'Before coverage')
  expectUnwatched('Before coverage')

  await act(async () => {
    await synchronizeTerminalProviderSnapshotCapabilities([ptyId], async () => [
      { id: ptyId, authoritative: true }
    ])
  })
  emitTitleAndBell(ptyId, 2, 'After coverage')
  expectWatched('After coverage')
})

it('waits for a retained workspace to return to the catalog before consuming output', async () => {
  const ptyId = `${WORKSPACE}@@retained`
  const { rerender } = watchBackgroundTab(ptyId, [], [])
  await act(async () => {
    await synchronizeTerminalProviderSnapshotCapabilities([ptyId], async () => [
      { id: ptyId, authoritative: true }
    ])
  })
  emitTitleAndBell(ptyId, 1, 'Outside catalog')
  expectUnwatched('Outside catalog')

  rerender({ workspaceSurfaceIds: [WORKSPACE] })
  emitTitleAndBell(ptyId, 2, 'Back in catalog')
  expectWatched('Back in catalog')
})

it('leaves floating terminal output to the floating panel owner', async () => {
  const ptyId = `${FLOATING_TERMINAL_WORKTREE_ID}@@floating-panel`
  watchBackgroundTab(ptyId, [], [], FLOATING_TERMINAL_WORKTREE_ID)
  await act(async () => {
    await synchronizeTerminalProviderSnapshotCapabilities([ptyId], async () => [
      { id: ptyId, authoritative: true }
    ])
  })
  emitTitleAndBell(ptyId, 1, 'Floating panel output')
  expectUnwatched('Floating panel output')
})

it('re-verdicts paired capability gain, loss, recovery and revocation without mounting', () => {
  const ptyId = 'remote:policy-host@@shell'
  watchBackgroundTab(ptyId)
  emitTitleAndBell(ptyId, 1, 'Unsupported host')
  expectUnwatched('Unsupported host')

  const updateHost = (
    capable: boolean,
    verification: RuntimeHostStatusSnapshot['verification'] = 'verified'
  ) => {
    const status = {
      ...createCompatibleRuntimeStatusResponse().result,
      capabilities: capable ? ['terminal.paired-parking.v1'] : []
    }
    act(() =>
      useAppStore.setState((state) => ({
        runtimeStatusByEnvironmentId: replaceMapEntries(state.runtimeStatusByEnvironmentId, [
          [
            'policy-host',
            {
              status: verification === 'verified' ? status : null,
              checkedAt: 1,
              snapshot: {
                environmentId: 'policy-host',
                pairingRevision: 1,
                sequence: 1,
                checkedAt: 1,
                status,
                verification,
                transport: 'ready'
              }
            }
          ]
        ])
      }))
    )
  }
  updateHost(true)
  emitTitleAndBell(ptyId, 2, 'Capable host')
  expectWatched('Capable host')
  clearAttention()
  updateHost(false)
  emitTitleAndBell(ptyId, 3, 'Capability withdrawn')
  expectUnwatched('Capability withdrawn')
  updateHost(true, 'unavailable')
  emitTitleAndBell(ptyId, 4, 'Last verified capability')
  expectWatched('Last verified capability')
  clearAttention()
  updateHost(true, 'blocked')
  emitTitleAndBell(ptyId, 5, 'Revoked host')
  expectUnwatched('Revoked host')
})

it('re-verdicts SSH parking off, on, off and on without mounting', () => {
  const ptyId = 'ssh:policy-host@@shell'
  watchBackgroundTab(ptyId)
  const setSshParking = (enabled: boolean) =>
    act(() =>
      useAppStore.setState({
        settings: createGlobalSettingsFixture({ terminalSshViewParking: enabled })
      })
    )
  emitTitleAndBell(ptyId, 1, 'SSH disabled')
  expectUnwatched('SSH disabled')
  setSshParking(true)
  emitTitleAndBell(ptyId, 2, 'SSH enabled')
  expectWatched('SSH enabled')
  clearAttention()
  setSshParking(false)
  emitTitleAndBell(ptyId, 3, 'SSH disabled again')
  expectUnwatched('SSH disabled again')
  setSshParking(true)
  emitTitleAndBell(ptyId, 4, 'SSH restored')
  expectWatched('SSH restored')
})

it('leaves an activity portal with its existing consumer when coverage resolves', async () => {
  const ptyId = `${WORKSPACE}@@portal`
  watchBackgroundTab(ptyId, [
    {
      worktreeId: WORKSPACE,
      tabId: TAB,
      slotId: 'slot',
      requestToken: 'request',
      target: document.createElement('div'),
      paneKey: `${TAB}:${LEAF}`,
      active: true
    }
  ])
  await act(async () => {
    await synchronizeTerminalProviderSnapshotCapabilities([ptyId], async () => [
      { id: ptyId, authoritative: true }
    ])
  })
  emitTitleAndBell(ptyId, 1, 'Portal output')
  expectUnwatched('Portal output')
})
