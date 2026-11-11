// @vitest-environment happy-dom

import type { DetectedWorktree } from '../../../shared/worktree/types'
import type { Tab } from '../../../shared/tab-types'
import { buildUnifiedTabSessionData } from '@/lib/workspace/persistence/workspace-session-unified-tabs'
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, renderHook, screen } from '@testing-library/react'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getDefaultSettings, getDefaultWorkspaceSession } from '../../../shared/constants'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { useTerminalWorkspaceFoundation } from './use-terminal-workspace-foundation'
import { WorktreeSplitSurface } from './TerminalWorktreeSplitSurface'
import type { WorkspaceTabDragState } from './tab-group/WorkspaceTabDragLayer'
import { getEffectiveLayoutForWorktree } from './terminal/split-group-mount'
import { selectWorkspacePresentationWorktrees } from '@/store/workspaces/catalog/retained-workspace-presentation'
import { buildSearchableWorkspaceTabEntries } from '@/lib/workspace/search/tabs/workspace-tab-palette-entry-builder'
import { searchWorkspaceTabs } from '@/lib/workspace/search/tabs/workspace-tab-palette-results'
import { activateWorkspaceTabPaletteResult } from '@/lib/workspace/search/tabs/workspace-tab-palette-activation'
import { activateAndRevealWorkspace } from '@/lib/workspace/activation/worktree-activation'
import {
  getPaletteOwnershipWorktreeIds,
  findAmbiguousWorktreeIds
} from '@/lib/workspace/ownership/unified-tab-host-ownership'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { stoppedWorkspaceListing } from './retained-bare-workspace.test-fixture'
import { mergeFetchedWorktrees } from '@/store/slices/worktrees/listing/fetched-worktree-merge'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { ensureSimulatorTab } from '@/lib/simulator/tabs/ensure-simulator-tab'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/sync-runtime-graph/graph-sync-scheduler', () => ({
  scheduleRuntimeGraphSync: vi.fn()
}))
vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({
  registerEagerPtyBuffer: vi.fn(),
  ensurePtyDispatcher: vi.fn()
}))
vi.mock('./WorkspacePaneOverlayLayers', () => ({ WorkspacePaneOverlayLayers: () => null }))
vi.mock('./tab-group/WorkspaceTabDragLayer', () => ({
  WorkspaceTabDragLayer: ({
    children
  }: {
    children: (input: WorkspaceTabDragState) => React.ReactNode
  }) => children({ isTabDragActive: false, hoveredTabInsertion: null, setDragRootNode: () => {} })
}))
// Process-backed leaf panes are represented at the layout boundary; hydration, routing and surfaces stay real.
vi.mock('./tab-group/TabGroupPanel', () => ({
  default: function TestTabGroupPanel({
    worktreeId,
    groupId,
    isVisible
  }: {
    worktreeId: string
    groupId: string
    isVisible: boolean
  }) {
    const tabs = useAppStore((state) => state.unifiedTabsByWorktree[worktreeId]) ?? []
    const group = useAppStore((state) =>
      state.groupsByWorktree[worktreeId]?.find((row) => row.id === groupId)
    )
    return (
      <section aria-label={groupId} hidden={!isVisible}>
        {tabs
          .filter((tab) => tab.groupId === groupId)
          .map((tab) => (
            <div key={tab.id} aria-current={tab.id === group?.activeTabId}>
              {tab.entityId}
            </div>
          ))}
      </section>
    )
  }
}))

const initialState = useAppStore.getInitialState()
const originalApi = Object.getOwnPropertyDescriptor(window, 'api')
const apiProxy = (): unknown =>
  new Proxy(() => undefined, {
    get: (_target, prop) => (prop === 'then' ? undefined : apiProxy()),
    apply: () => Promise.resolve(null)
  })
const bare = makeWorktree({
  id: 'repo1::/repo/.bare',
  repoId: 'repo1',
  path: '/repo/.bare',
  isBare: true,
  isMainWorktree: true,
  hostId: 'local'
})
const checkout = makeWorktree({
  id: 'repo1::/repo/main',
  repoId: 'repo1',
  path: '/repo/main',
  hostId: 'local'
})

function RetainedSurfaces() {
  const foundation = useTerminalWorkspaceFoundation()
  const layouts = useAppStore((state) => state.layoutByWorktree)
  const groups = useAppStore((state) => state.groupsByWorktree)
  const activeGroups = useAppStore((state) => state.activeGroupIdByWorktree)
  return foundation.workspaceSurfaces.map((workspace) => {
    const layout = getEffectiveLayoutForWorktree(workspace.id, layouts, groups, activeGroups)
    return layout ? (
      <WorktreeSplitSurface
        key={workspace.id}
        worktreeId={workspace.id}
        worktreePath={workspace.path}
        layout={layout}
        focusedGroupId={activeGroups[workspace.id]}
        isVisible={foundation.renderedActiveWorktreeId === workspace.id}
        shouldMeasureHiddenWorktree={false}
        prewarmStage={null}
        shouldColdParkTerminalPanes={false}
        isForceParked={false}
        activityTerminalPortals={[]}
        backgroundMountTabIds={null}
        activationDeferredMountTabIds={null}
      />
    ) : null
  })
}

function searchTabs(query: string) {
  const state = useAppStore.getState()
  const worktrees = Object.values(selectWorkspacePresentationWorktrees(state)).flat()
  return searchWorkspaceTabs(
    buildSearchableWorkspaceTabEntries({
      ...state,
      worktrees,
      ownershipWorktrees: getPaletteOwnershipWorktreeIds(state),
      repoMap: new Map([[TEST_REPO.id, TEST_REPO]]),
      worktreeOrder: new Map(),
      generatedTitlesEnabled: false,
      chatNames: new Map()
    }),
    query
  )
}

afterEach(() => {
  cleanup()
  useAppStore.setState(initialState, true)
  vi.restoreAllMocks()
  if (originalApi) {
    Object.defineProperty(window, 'api', originalApi)
  } else {
    Reflect.deleteProperty(window, 'api')
  }
})

it.each(['scanned', 'stopped WSL', 'failed refresh'] as const)(
  'hydrates, renders and rediscovers original shell/chat panes after %s listing',
  (listing) => {
    Object.defineProperty(window, 'api', { configurable: true, value: apiProxy() })
    useAppStore.setState(
      {
        ...initialState,
        repos: [TEST_REPO],
        worktreesByRepo: { repo1: [checkout] },
        detectedWorktreesByRepo: {
          repo1: {
            repoId: 'repo1',
            authoritative: true,
            source: 'git',
            worktrees: [bare, checkout].map(
              (row) =>
                ({
                  ...row,
                  ownership: 'external',
                  selectedCheckout: false,
                  visible: !row.isBare
                }) satisfies DetectedWorktree
            )
          }
        }
      },
      true
    )
    const session = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: bare.id,
      activeWorkspaceExecutionHostId: 'local' as const,
      activeTabId: 'old-shell',
      activeTabIdByWorktree: { [bare.id]: 'old-shell' },
      tabsByWorktree: {
        [bare.id]: [makeTab({ id: 'old-shell', worktreeId: bare.id, title: 'Saved shell' })]
      },
      unifiedTabs: {
        [bare.id]: [
          {
            id: 'shell-tab',
            entityId: 'old-shell',
            groupId: 'original-group',
            worktreeId: bare.id,
            executionHostId: 'local' as const,
            contentType: 'terminal' as const,
            label: 'Saved shell',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          },
          {
            id: 'chat-tab',
            entityId: 'old-chat',
            groupId: 'original-group',
            worktreeId: bare.id,
            executionHostId: 'local' as const,
            contentType: 'agent-session' as const,
            agentSessionAgent: 'claude' as const,
            label: 'Saved conversation',
            customLabel: null,
            color: null,
            sortOrder: 1,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [bare.id]: [
          {
            id: 'original-group',
            worktreeId: bare.id,
            activeTabId: 'shell-tab',
            tabOrder: ['shell-tab', 'chat-tab']
          }
        ]
      }
    }
    useAppStore.getState().hydrateWorkspaceSession(session)
    useAppStore.getState().hydrateTabsSession(session)
    if (listing === 'stopped WSL') {
      const repo = { ...TEST_REPO, path: '/repo' }
      const fallback = stoppedWorkspaceListing(repo, [bare, checkout])
      expect(fallback.worktrees.find((row) => row.id === bare.id)?.isBare).toBe(false)
      expect(
        mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
          repoId: 'repo1',
          hostId: 'local',
          ownerWasMissingAtStart: false,
          requestStartedWorktrees: [checkout],
          refresh: { status: 'admitted', executionHostId: 'local', result: fallback }
        })
      ).toBe('applied')
      expect(useAppStore.getState().worktreesByRepo.repo1.map((row) => row.id)).toEqual([
        checkout.id
      ])
    }
    if (listing === 'failed refresh') {
      expect(
        mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
          repoId: 'repo1',
          hostId: 'local',
          ownerWasMissingAtStart: false,
          requestStartedWorktrees: [checkout],
          refresh: {
            status: 'admitted',
            executionHostId: 'local',
            result: {
              repoId: 'repo1',
              authoritative: false,
              source: 'metadata-fallback',
              worktrees: []
            }
          }
        })
      ).toBe('applied')
    }
    render(<RetainedSurfaces />)
    expect(screen.getByRole('region', { name: 'original-group' }).textContent).toBe(
      'old-shellold-chat'
    )
    expect(useAppStore.getState().worktreesByRepo.repo1.map((row) => row.id)).toEqual([checkout.id])
    if (listing === 'stopped WSL') {
      const current = useAppStore.getState().detectedWorktreesByRepo.repo1
      // A settled hidden non-bare identity still owns the same retained content.
      act(() => {
        expect(
          mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
            repoId: 'repo1',
            hostId: 'local',
            ownerWasMissingAtStart: false,
            requestStartedWorktrees: useAppStore.getState().worktreesByRepo.repo1,
            refresh: {
              status: 'admitted',
              executionHostId: 'local',
              result: {
                ...current,
                authoritative: true,
                source: 'git',
                wslDistroStopped: undefined,
                worktrees: current.worktrees
                  .filter((row) => row.id === bare.id || row.id === checkout.id)
                  .map((row) => ({ ...row, visible: row.id !== bare.id }))
              }
            }
          })
        ).toBe('applied')
      })
      expect(screen.getByRole('region', { name: 'original-group' }).textContent).toBe(
        'old-shellold-chat'
      )
    }
    act(() => {
      activateAndRevealWorkspace(checkout.id, { providesInitialSurface: true })
    })
    expect(screen.queryByRole('region', { name: 'original-group' })).toBeNull()
    for (const title of ['Saved shell', 'Saved conversation']) {
      const match = searchTabs(title).find((row) => row.worktreeId === bare.id)
      expect(match).toBeDefined()
      if (!match) {
        throw new Error('missing retained tab')
      }
      act(() => {
        expect(activateWorkspaceTabPaletteResult(match)).toEqual({ status: 'activated' })
      })
      expect(screen.getByRole('region', { name: 'original-group' }).textContent).toBe(
        'old-shellold-chat'
      )
      expect(useAppStore.getState().groupsByWorktree[bare.id][0].activeTabId).toBe(match.tabId)
      expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('local')
    }
    if (listing === 'failed refresh') {
      act(() => {
        expect(
          mergeFetchedWorktrees(useAppStore.setState, useAppStore.getState, {
            repoId: 'repo1',
            hostId: 'local',
            ownerWasMissingAtStart: false,
            requestStartedWorktrees: [checkout],
            refresh: {
              status: 'admitted',
              executionHostId: 'local',
              result: {
                repoId: 'repo1',
                authoritative: true,
                source: 'git',
                worktrees: [
                  { ...checkout, ownership: 'external', selectedCheckout: true, visible: true }
                ]
              }
            }
          })
        ).toBe('applied')
      })
      expect(screen.queryByRole('region', { name: 'original-group', hidden: true })).toBeNull()
      expect(searchTabs('Saved')).toEqual([])
    }
    act(() => {
      useAppStore.setState((state) => ({
        tabsByWorktree: replaceRecordEntries<AppState['tabsByWorktree'][string]>(
          state.tabsByWorktree,
          [[bare.id, null]]
        ),
        unifiedTabsByWorktree: replaceRecordEntries<AppState['unifiedTabsByWorktree'][string]>(
          state.unifiedTabsByWorktree,
          [[bare.id, null]]
        )
      }))
    })
    expect(screen.queryByRole('region', { name: 'original-group', hidden: true })).toBeNull()
    expect(searchTabs('Saved')).toEqual([])
  }
)

it('keeps host twins ambiguous and drops truly removed identities despite retained bytes', () => {
  const remote = { ...bare, hostId: 'runtime:other' as const, runtimeOwnerEnvironmentId: 'other' }
  useAppStore.setState(
    {
      ...initialState,
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [checkout] },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [bare, remote].map(
            (row) =>
              ({
                ...row,
                ownership: 'external',
                selectedCheckout: false,
                visible: false
              }) satisfies DetectedWorktree
          )
        }
      },
      unifiedTabsByWorktree: {
        [bare.id]: [
          {
            id: 'chat',
            entityId: 'chat',
            groupId: 'group',
            worktreeId: bare.id,
            contentType: 'agent-session',
            label: 'Saved',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      }
    },
    true
  )
  const state = useAppStore.getState()
  expect(findAmbiguousWorktreeIds(getPaletteOwnershipWorktreeIds(state)).has(bare.id)).toBe(true)
  expect(getResolvedExecutionHostIdForWorktree(state, bare.id)).toBeNull()
  expect(searchTabs('Saved')).toEqual([])
  useAppStore.setState({ detectedWorktreesByRepo: {} })
  expect(
    Object.values(selectWorkspacePresentationWorktrees(useAppStore.getState()))
      .flat()
      .map((row) => row.id)
  ).toEqual([checkout.id])
})

it('preserves unresolved browser ownership after restoring hostless content beside a hidden twin', async () => {
  Object.defineProperty(window, 'api', { configurable: true, value: apiProxy() })
  const listed = { ...checkout, hostId: 'ssh:a' as const }
  const hidden = { ...listed, hostId: 'ssh:b' as const }
  const saved: Tab = {
    id: 'legacy-chat',
    entityId: 'legacy-chat',
    worktreeId: listed.id,
    groupId: 'twin-group',
    contentType: 'agent-session',
    label: 'Legacy conversation',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  useAppStore.setState(
    {
      ...initialState,
      repos: [{ ...TEST_REPO, executionHostId: 'ssh:a', connectionId: 'a' }],
      worktreesByRepo: { repo1: [listed] },
      detectedWorktreesByRepo: {
        repo1: {
          repoId: 'repo1',
          authoritative: true,
          source: 'git',
          worktrees: [{ ...hidden, ownership: 'external', selectedCheckout: false, visible: false }]
        }
      },
      unifiedTabsByWorktree: { [listed.id]: [saved] },
      groupsByWorktree: {
        [listed.id]: [
          { id: 'twin-group', worktreeId: listed.id, activeTabId: saved.id, tabOrder: [saved.id] }
        ]
      }
    },
    true
  )
  const session = {
    ...getDefaultWorkspaceSession(),
    ...buildUnifiedTabSessionData(useAppStore.getState()),
    activeRepoId: 'repo1',
    activeWorktreeId: listed.id,
    activeWorkspaceExecutionHostId: null
  }
  useAppStore.setState({ unifiedTabsByWorktree: {}, groupsByWorktree: {}, activeWorktreeId: null })
  useAppStore.getState().hydrateWorkspaceSession(session)
  useAppStore.getState().hydrateTabsSession(session)
  const foundation = renderHook(() => useTerminalWorkspaceFoundation())
  expect(foundation.result.current.workspaceSurfaces.filter((row) => row.id === listed.id)).toEqual(
    [{ id: listed.id, path: listed.path }]
  )
  expect(getResolvedExecutionHostIdForWorktree(useAppStore.getState(), listed.id)).toBeNull()
  expect(searchTabs('Legacy conversation')).toEqual([])
  await act(async () => {
    await useAppStore.getState().openNewBrowserTabInActiveWorkspace('twin-group')
  })
  const unqualified = useAppStore
    .getState()
    .unifiedTabsByWorktree[listed.id].find((tab) => tab.contentType === 'browser')
  expect(unqualified?.executionHostId).toBeUndefined()
  expect(useAppStore.getState().browserTabsByWorktree[listed.id]).toHaveLength(1)
  expect(
    useAppStore.getState().unifiedTabsByWorktree[listed.id].find((tab) => tab.id === saved.id)
      ?.executionHostId
  ).toBeUndefined()
  act(() => {
    const explicitB = useAppStore.getState().createUnifiedTab(listed.id, 'agent-session', {
      id: 'b-chat',
      entityId: 'b-chat',
      label: 'B conversation',
      executionHostId: 'ssh:b',
      targetGroupId: 'twin-group'
    })
    expect(explicitB.executionHostId).toBe('ssh:b')
  })
  const bResult = searchTabs('B conversation')[0]
  expect(bResult?.executionHostId).toBe('ssh:b')
  act(() => {
    expect(activateWorkspaceTabPaletteResult(bResult)).toEqual({ status: 'activated' })
  })
  expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe('ssh:b')
  await act(async () => {
    await useAppStore.getState().openNewBrowserTabInActiveWorkspace('twin-group')
  })
  expect(
    useAppStore
      .getState()
      .unifiedTabsByWorktree[listed.id].filter((tab) => tab.contentType === 'browser')
      .map((tab) => tab.executionHostId)
  ).toEqual([undefined, 'ssh:b'])
  act(() => {
    useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:a' })
  })
  await act(async () => {
    await useAppStore.getState().openNewBrowserTabInActiveWorkspace('twin-group')
  })
  expect(
    useAppStore
      .getState()
      .unifiedTabsByWorktree[listed.id].filter((tab) => tab.contentType === 'browser')
      .map((tab) => tab.executionHostId)
  ).toEqual([undefined, 'ssh:b', 'ssh:a'])
  act(() => {
    useAppStore.setState({ activeWorkspaceExecutionHostId: null })
  })
  let splitTab: Tab | null = null
  act(() => {
    splitTab = useAppStore
      .getState()
      .createUnifiedTabInSplit(
        listed.id,
        'terminal',
        { sourceGroupId: 'twin-group', splitDirection: 'right' },
        { id: 'unqualified-split', entityId: 'unqualified-split' }
      )
  })
  expect(splitTab).not.toBeNull()
  expect(
    useAppStore
      .getState()
      .unifiedTabsByWorktree[listed.id].find((tab) => tab.id === 'unqualified-split')
      ?.executionHostId
  ).toBeUndefined()
  act(() => {
    useAppStore.setState({ detectedWorktreesByRepo: {} })
  })
  const unique = useAppStore
    .getState()
    .createUnifiedTab(listed.id, 'terminal', { id: 'unique-tab', entityId: 'unique-tab' })
  expect(unique.executionHostId).toBe('ssh:a')
  act(() => {
    useAppStore.setState({
      worktreesByRepo: { repo1: [checkout] },
      repos: [TEST_REPO],
      activeWorkspaceExecutionHostId: null
    })
  })
  const local = useAppStore
    .getState()
    .createUnifiedTab(listed.id, 'terminal', { id: 'local-tab', entityId: 'local-tab' })
  expect(local.executionHostId).toBe('local')
})

it('reuses an unresolved simulator without claiming a host or adopting a scoped twin', () => {
  Object.defineProperty(window, 'api', { configurable: true, value: apiProxy() })
  const remote = { ...checkout, hostId: 'ssh:other' as const }
  useAppStore.setState(
    {
      ...initialState,
      settings: { ...getDefaultSettings('/qa'), mobileEmulatorEnabled: true },
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [checkout, remote] },
      activeWorktreeId: checkout.id,
      activeWorkspaceExecutionHostId: null,
      groupsByWorktree: {
        [checkout.id]: [
          { id: 'sim-group', worktreeId: checkout.id, tabOrder: [], activeTabId: null }
        ]
      },
      activeGroupIdByWorktree: { [checkout.id]: 'sim-group' }
    },
    true
  )
  const first = ensureSimulatorTab(checkout.id, { targetGroupId: 'sim-group', surfacePane: false })
  const second = ensureSimulatorTab(checkout.id, { targetGroupId: 'sim-group', surfacePane: false })
  expect(first).not.toBeNull()
  expect(second).toBe(first)
  const unresolved = useAppStore.getState().unifiedTabsByWorktree[checkout.id]
  expect(unresolved).toHaveLength(1)
  expect(unresolved[0].executionHostId).toBeUndefined()
  const scoped = ensureSimulatorTab(checkout.id, {
    targetGroupId: 'sim-group',
    surfacePane: false,
    executionHostId: 'ssh:other'
  })
  expect(scoped).not.toBe(first)
  expect(
    ensureSimulatorTab(checkout.id, {
      targetGroupId: 'sim-group',
      surfacePane: false,
      executionHostId: 'ssh:other'
    })
  ).toBe(scoped)
  expect(ensureSimulatorTab(checkout.id, { targetGroupId: 'sim-group', surfacePane: false })).toBe(
    first
  )
  expect(
    useAppStore.getState().unifiedTabsByWorktree[checkout.id].map((tab) => tab.executionHostId)
  ).toEqual([undefined, 'ssh:other'])
})
