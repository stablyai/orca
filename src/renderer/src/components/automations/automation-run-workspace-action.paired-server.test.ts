// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTabGroup, makeUnifiedTab } from '@/store/slices/store-test-helpers'
import type { Tab } from '../../../../shared/tab-types'
import { installAutomationChatRunCases } from './automation-run-workspace-chat.test-fixture'
import type { AutomationRun } from '../../../../shared/automations-types'
import type {
  AutomationAuthorityRef,
  AutomationOwnerRef
} from '../../../../shared/automation-owner-ref'
import type { Worktree } from '../../../../shared/worktree/types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import {
  makeAutomation,
  makeAutomationListRow,
  makeRun,
  makeWorktree
} from './automations-page-fixtures'
import {
  makeFolderWorkspace,
  makeProjectGroup
} from '../sidebar/folder-workspace-composer-submit-fixtures'
import { getFolderWorkspaceHostId } from '../../../../shared/folder-workspace-execution-host'
import { getRuntimeEnvironmentIdForFolderWorkspace } from '@/lib/folder-workspace-runtime-owner'
import { hostStableKey, toStableCatalogRef } from '../../../../shared/automation-owner-key'
import { capturedAutomationOwnerKey } from './automation-captured-owner'
import { createAutomationRunWorkspaceAction } from './automation-run-workspace-action'
import { useAutomationsPageListState } from './use-automations-page-list-state'
import { useAutomationRunPageState } from './use-automation-run-page-state'
import { EMPTY_AUTOMATION_LIST_FILTER } from './automation-list-view'

const mocks = vi.hoisted(() => {
  const state: Record<string, unknown> = {}
  const catalog: Record<string, unknown> = {}
  const chatTabs: Tab[] = []
  return {
    state,
    listeners: new Set<() => void>(),
    catalog,
    chatTabs,
    activateTab: vi.fn(),
    rpc: vi.fn(),
    toastError: vi.fn(),
    toastMessage: vi.fn(),
    activate: vi.fn(() => true),
    ownerActivate: vi.fn(async () => true)
  }
})
vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state,
      subscribe: (listener: () => void) => {
        mocks.listeners.add(listener)
        return () => mocks.listeners.delete(listener)
      }
    }
  )
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mocks.rpc,
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toastError, message: mocks.toastMessage } }))
vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: mocks.activate,
  activateAndRevealFolderWorkspace: mocks.activate
}))
vi.mock('@/runtime/web-runtime-session-tab-lifecycle', () => ({
  activateWebRuntimeSessionTab: mocks.ownerActivate
}))
vi.mock('@/runtime/web-runtime-session-environment', () => ({
  isWebRuntimeSessionActive: (id: string | null) => !!id
}))
vi.mock('./use-automation-host-catalog', () => ({ useAutomationHostCatalog: () => mocks.catalog }))
vi.mock('./use-scoped-external-automations', () => ({
  useScopedExternalAutomations: () => ({ managers: [], failures: [] })
}))
vi.mock('./use-automation-list-search', () => ({
  useAutomationListSearch: () => ({ filteredRows: [], filteredExternalAutomationEntries: [] })
}))

const ENV = 'env-a'
const WT = 'repo-a::/srv/app'
const GROUP = 'recorded-chat-group'
const LEAF = '11111111-1111-4111-8111-111111111111'
const TAB = 'host-tab-1'
const MIRROR = toWebTerminalSurfaceTabId(TAB)
const P = 'pty-original'
const run = makeRun({
  id: 'old-run',
  workspaceId: WT,
  workspaceDisplayName: 'Recorded name',
  terminalSessionId: TAB,
  terminalPaneKey: `${TAB}:${LEAF}`,
  terminalPtyId: P,
  runContext: {
    kind: 'workspace-run',
    projectId: 'old-project',
    projectHostSetupId: 'old-setup',
    repoId: 'repo-a',
    hostId: 'local',
    path: '/srv/app'
  }
})
const desktop: AutomationAuthorityRef = { kind: 'desktop' }
const runtime: AutomationAuthorityRef = { kind: 'runtime', environmentId: ENV, pairingRevision: 4 }
const roots: Root[] = []
let current: {
  list: ReturnType<typeof useAutomationsPageListState>
  detail: ReturnType<typeof useAutomationRunPageState>
  open: (run: AutomationRun) => void
}

function worktree(hostId: Worktree['hostId'], overrides: Partial<Worktree> = {}): Worktree {
  // SAFETY: the historical consumers read only identity, path, display and owner fields.
  return makeWorktree({
    id: WT,
    repoId: 'repo-a',
    path: '/srv/app',
    displayName: `Live ${hostId}`,
    hostId,
    ...overrides
  })
}
function seed(rows: Worktree[], authority: AutomationAuthorityRef = desktop) {
  const selected = makeAutomationListRow({
    automation: makeAutomation({ projectId: 'retargeted', workspaceId: 'somewhere-else' })
  })
  const owner: AutomationOwnerRef = { authority, selector: { kind: 'self' } }
  const captured: { owner: AutomationOwnerRef; selector: AutomationOwnerRef['selector'] } = {
    owner,
    selector: { kind: 'self' }
  }
  mocks.catalog = {
    rows: { answered: true, rows: [selected], capturedOwners: new Map([[selected.key, captured]]) },
    entries: [],
    resolution: { effective: { kind: 'all' } }
  }
  mocks.state = {
    activeWorktreeId: 'unrelated',
    activeWorkspaceExecutionHostId: 'ssh:other',
    repos: rows.map((row) => ({ id: row.repoId, path: row.path, executionHostId: row.hostId })),
    worktreesByRepo: { 'repo-a': rows },
    folderWorkspaces: [],
    projectGroups: [],
    runtimeEnvironments: [{ id: ENV, createdAt: 1, pairingRevision: 4 }],
    unifiedTabsByWorktree: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {},
    ptyIdsByTabId: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    setTabLayout: vi.fn(),
    setActiveTab: vi.fn(),
    setActiveTabType: vi.fn()
  }
  const local = {
    automations: [selected.automation],
    failedAuthorityKeys: new Set<string>(),
    listSearchQuery: '',
    listFilter: EMPTY_AUTOMATION_LIST_FILTER,
    listSort: null,
    selectedRowKey: selected.key,
    selectedExternalKey: null,
    workspaceNameCacheRef: { current: new Map<string, string>() },
    selectedAutomationRuns: {
      automationId: selected.automation.id,
      rowKey: selected.key,
      ownerKey: capturedAutomationOwnerKey(captured),
      authority,
      capturedOwner: captured,
      runs: [run],
      navigation: null,
      reloadToken: -1,
      notice: null
    },
    setSelectedAutomationRunPageId: vi.fn(),
    setSelectedRowKey: vi.fn(),
    setRunHistoryAcquisitionToken: vi.fn(),
    selectExternalKey: vi.fn(),
    isLoading: false,
    automationHostTargetKey: null,
    pageView: 'automations' as const,
    setPageView: vi.fn(),
    setRunPageOrigin: vi.fn(),
    isDetailOpen: false,
    rerunRunIdsInFlight: new Set<string>(),
    setIsDetailOpen: vi.fn(),
    setActivePaneTab: vi.fn()
  }
  const store = {
    runtimeEnvironments: [],
    pendingAutomationRunNavigation: null,
    selectedId: selected.automation.id,
    setSelectedId: vi.fn(),
    repoMap: new Map(),
    worktreeMap: new Map(),
    setPendingAutomationRunNavigation: vi.fn()
  }
  return { local, store, selected }
}
function pane(
  workspaceId: string,
  hostId: Worktree['hostId'],
  mirrored = false,
  stamped = true
): void {
  const tabId = mirrored ? MIRROR : TAB
  const ptyId = mirrored ? toRemoteRuntimePtyId('handle', ENV) : P
  mocks.state.unifiedTabsByWorktree = {
    [workspaceId]: [
      {
        id: tabId,
        entityId: tabId,
        worktreeId: workspaceId,
        contentType: 'terminal',
        ...(stamped ? { executionHostId: hostId } : {})
      }
    ]
  }
  mocks.state.terminalLayoutsByTabId = {
    [tabId]: {
      root: { type: 'leaf', leafId: LEAF },
      activeLeafId: LEAF,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF]: ptyId }
    }
  }
  mocks.state.ptyIdsByTabId = { [tabId]: [ptyId] }
}
async function mount(input: ReturnType<typeof seed>, selectedRun = run) {
  function Harness() {
    // SAFETY: omitted page editing and catalog-search members are not used by this historical path.
    const args = { ...input, store: { ...input.store } } satisfies Parameters<
      typeof useAutomationsPageListState
    >[0]
    const list = useAutomationsPageListState(args)
    const detail = useAutomationRunPageState({
      ...args,
      list,
      // SAFETY: only selected historical records are read by this hook's detail projection.
      setup: {
        selectedRuns: [selectedRun],
        selectedAutomationRunPage: selectedRun,
        selectedRunsReady: false,
        selectedRunsNotice: null
      }
    })
    // SAFETY: the action consumes the list's actual historical resolver only.
    const context = { list } satisfies Parameters<typeof createAutomationRunWorkspaceAction>[0]
    current = { list, detail, open: createAutomationRunWorkspaceAction(context) }
    return null
  }
  const root = createRoot(document.createElement('div'))
  roots.push(root)
  const render = async () => {
    await act(async () => root.render(createElement(Harness)))
  }
  await render()
  return render
}
function expectOpen(hostId: string, tabId: string, environmentId: string | null) {
  expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
  expect(current.detail.selectedAutomationRunPageWorkspaceDisplay?.rowLabel).toBe('Recorded name')
  current.open(run)
  expect(mocks.activate).toHaveBeenCalledWith(WT, {
    executionHostId: hostId,
    runtimeEnvironmentId: environmentId,
    providesInitialSurface: true
  })
  expect(mocks.state.setActiveTab).toHaveBeenCalledWith(tabId)
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  vi.clearAllMocks()
  mocks.activate.mockReturnValue(true)
  mocks.chatTabs.length = 0
  mocks.rpc.mockImplementation(async (_target, method, params) => {
    if (method === 'agentSession.reveal') {
      mocks.chatTabs.push(
        makeUnifiedTab({
          id: 'recorded-chat',
          groupId: GROUP,
          entityId: params.sessionId,
          worktreeId: WT,
          executionHostId: `runtime:${ENV}`,
          contentType: 'agent-session'
        })
      )
    }
    return { ok: true }
  })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await act(async () => roots.splice(0).forEach((root) => root.unmount()))
})

describe('historical affordance, physical owner, exact pane and serving authority', () => {
  it.each([false, true])(
    'keeps exact local history after definition retarget/removal with twins, reversed=%s',
    async (reverse) => {
      const rows = [worktree('local'), worktree('ssh:box')]
      if (reverse) {
        rows.reverse()
      }
      const input = seed(rows)
      pane(WT, 'local')
      await mount(input)
      expectOpen('local', TAB, null)
      expect(mocks.ownerActivate).not.toHaveBeenCalled()
      input.selected.automation = makeAutomation({ projectId: 'deleted-repo' })
      current.open(run)
      expect(mocks.state.setActiveTab).toHaveBeenLastCalledWith(TAB)
    }
  )
  it('opens the exact hibernated local pane without a live PTY or replacement shell', async () => {
    const input = seed([worktree('local'), worktree('ssh:box')])
    pane(WT, 'local')
    mocks.state.ptyIdsByTabId = {}
    const slept = { ...run, terminalPtyId: null }
    input.local.selectedAutomationRuns.runs = [slept]
    await mount(input, slept)
    current.open(slept)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    expect(mocks.state.setActiveTab).toHaveBeenCalledWith(TAB)
    expect(mocks.activate).toHaveBeenCalledWith(
      WT,
      expect.objectContaining({ executionHostId: 'local', providesInitialSurface: true })
    )
  })
  it('uses acquired runtime for hydrated mirror and owner focus despite unrelated local twin', async () => {
    const input = seed(
      [worktree('local'), worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })],
      runtime
    )
    pane(WT, 'runtime:env-a', true)
    await mount(input)
    expectOpen('runtime:env-a', MIRROR, ENV)
    await vi.waitFor(() =>
      expect(mocks.ownerActivate).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: WT, tabId: MIRROR, environmentId: ENV, leafId: LEAF })
      )
    )
  })
  it('requests the exact owner pane before mirror hydration without creating a local tab', async () => {
    const input = seed([worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })], runtime)
    await mount(input)
    current.open(run)
    await vi.waitFor(() =>
      expect(mocks.ownerActivate).toHaveBeenCalledWith(
        expect.objectContaining({ worktreeId: WT, tabId: TAB, environmentId: ENV, leafId: LEAF })
      )
    )
    expect(mocks.state.setActiveTab).not.toHaveBeenCalled()
    expect(mocks.activate).toHaveBeenCalledWith(
      WT,
      expect.objectContaining({ providesInitialSurface: true })
    )
  })
  it('keeps the acquired owner route reachable when neither workspace nor pane mirror is hydrated', async () => {
    const input = seed([worktree('local')], runtime)
    const hydrate = vi.fn(async () => {
      mocks.state.worktreesByRepo = {
        'repo-a': [worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })]
      }
      pane(WT, 'runtime:env-a', true)
      return []
    })
    mocks.state.fetchRuntimeEnvironmentRepos = hydrate
    mocks.state.fetchAllWorktrees = vi.fn(async () => {})
    await mount(input)
    current.open(run)
    expect(mocks.ownerActivate).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: TAB, environmentId: ENV, leafId: LEAF })
    )
    await vi.waitFor(() => expect(mocks.state.setActiveTab).toHaveBeenCalledWith(MIRROR))
    expect(hydrate).toHaveBeenCalledWith(ENV)
    expect(mocks.ownerActivate).toHaveBeenCalledTimes(1)
    expect(mocks.activate).toHaveBeenCalledWith(
      WT,
      expect.objectContaining({ executionHostId: 'runtime:env-a', providesInitialSurface: true })
    )
  })
  it('retains the acquired historical target after its current definition disappears', async () => {
    const input = seed([worktree('local')])
    pane(WT, 'local')
    const render = await mount(input)
    mocks.catalog.rows = { answered: true, rows: [], capturedOwners: new Map() }
    input.local.automations = []
    await render()
    expectOpen('local', TAB, null)
  })
  it('refuses an acquired SSH generation after target removal while preserving its history', async () => {
    const input = seed([worktree('ssh:box')])
    const captured = {
      owner: {
        authority: desktop,
        selector: { kind: 'ssh' as const, targetId: 'box', targetGeneration: 7 }
      },
      selector: { kind: 'ssh' as const, targetId: 'box', targetGeneration: 7 }
    }
    input.local.selectedAutomationRuns.ownerKey = capturedAutomationOwnerKey(captured)
    input.local.selectedAutomationRuns.capturedOwner = captured
    const stableRef = toStableCatalogRef(captured.owner)
    const stableKey = hostStableKey(stableRef)
    mocks.catalog.entries = [
      { stableRef, stableKey, owner: captured.owner, catalogState: 'authoritative' }
    ]
    mocks.catalog.rows = {
      answered: true,
      rows: [input.selected],
      capturedOwners: new Map([[input.selected.key, captured]])
    }
    mocks.state.sshTargetGenerations = new Map([['box', 7]])
    mocks.state.sshTargetsHydrated = true
    const sshRun: AutomationRun = { ...run, runContext: { ...run.runContext!, hostId: 'ssh:box' } }
    input.local.selectedAutomationRuns.runs = [sshRun]
    pane(WT, 'ssh:box')
    const render = await mount(input, sshRun)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    mocks.catalog.rows = { answered: true, rows: [], capturedOwners: new Map() }
    mocks.catalog.entries = [{ stableRef, stableKey, owner: null, catalogState: 'removed' }]
    mocks.state.sshTargetGenerations = new Map()
    mocks.state.removedSshTargetLabels = new Map([['box', 'Removed box']])
    await render()
    expect(current.list.selectedAutomationRunsWithWorkspaceNames[0].id).toBe(sshRun.id)
    current.open(sshRun)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(false)
    mocks.catalog.entries = [
      {
        stableRef,
        stableKey,
        owner: { ...captured.owner, selector: { ...captured.owner.selector, targetGeneration: 8 } },
        catalogState: 'authoritative'
      }
    ]
    mocks.state.sshTargetGenerations = new Map([['box', 8]])
    await render()
    current.open(sshRun)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(false)
  })
  it.each(['owner', 'repos', 'worktrees', 're-pair', 'away-return', 'superseding'])(
    'does not reveal a pre-mirror run after navigation cancellation at %s',
    async (stage) => {
      const input = seed([worktree('local')], runtime)
      let release!: () => void
      const pending = new Promise<void>((resolve) => {
        release = resolve
      })
      const hydrate = () => {
        mocks.state.worktreesByRepo = {
          'repo-a': [worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })]
        }
        pane(WT, 'runtime:env-a', true)
      }
      const fetchRepos = vi.fn(async () => {
        if (stage !== 'worktrees') {
          await pending
        }
        return []
      })
      const fetchWorktrees = vi.fn(async () => {
        if (stage === 'worktrees') {
          await pending
        }
        hydrate()
      })
      if (stage === 'owner') {
        mocks.ownerActivate.mockImplementationOnce(async () => {
          await pending
          return true
        })
      }
      mocks.state.fetchRuntimeEnvironmentRepos = fetchRepos
      mocks.state.fetchAllWorktrees = fetchWorktrees
      await mount(input)
      current.open(run)
      await vi.waitFor(() =>
        expect(
          stage === 'owner'
            ? mocks.ownerActivate
            : stage === 'worktrees'
              ? fetchWorktrees
              : fetchRepos
        ).toHaveBeenCalled()
      )
      const origin = [mocks.state.activeWorktreeId, mocks.state.activeWorkspaceExecutionHostId]
      mocks.state.activeWorktreeId = 'chosen-after-open'
      mocks.state.activeWorkspaceExecutionHostId = 'local'
      mocks.listeners.forEach((listener) => listener())
      if (stage === 'away-return') {
        mocks.state.activeWorktreeId = origin[0]
        mocks.state.activeWorkspaceExecutionHostId = origin[1]
        mocks.listeners.forEach((listener) => listener())
      }
      if (stage === 'superseding') {
        current.open({ ...run, workspaceId: null })
      }
      if (stage === 're-pair') {
        mocks.state.runtimeEnvironments = [{ id: ENV, createdAt: 1, pairingRevision: 5 }]
      }
      await act(async () => {
        release()
        await pending
      })
      expect(mocks.activate).not.toHaveBeenCalled()
      expect(mocks.state.setActiveTab).not.toHaveBeenCalled()
      expect(mocks.state.activeWorktreeId).toBe(
        stage === 'away-return' ? origin[0] : 'chosen-after-open'
      )
    }
  )
  it('separates physical SSH folder from local PROJECT context and HUB serving owner', async () => {
    const input = seed([], runtime)
    mocks.state.folderWorkspaces = [
      makeFolderWorkspace({ id: 'folder', executionHostId: 'runtime:env-a', connectionId: 'box' })
    ]
    const folderRun = { ...run, workspaceId: 'folder:folder' }
    input.local.selectedAutomationRuns.runs = [folderRun]
    pane('folder:folder', 'runtime:env-a', true)
    await mount(input, folderRun)
    current.open(folderRun)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    expect(mocks.activate).toHaveBeenCalledWith(
      'folder:folder',
      expect.objectContaining({ executionHostId: 'runtime:env-a', runtimeEnvironmentId: ENV })
    )
    await vi.waitFor(() =>
      expect(mocks.ownerActivate).toHaveBeenCalledWith(
        expect.objectContaining({ environmentId: ENV, leafId: LEAF })
      )
    )
  })
  it('keeps physical ssh:X distinct from the HUB runtime E serving a mirrored folder pane', async () => {
    const input = seed([], runtime)
    vi.stubGlobal('__ORCA_WEB_CLIENT__', true)
    mocks.state.settings = { activeRuntimeEnvironmentId: ENV }
    mocks.state.folderWorkspaces = [
      makeFolderWorkspace({ id: 'folder', executionHostId: 'ssh:box', connectionId: 'box' })
    ]
    mocks.state.repos = [
      {
        id: 'real-project-repo',
        projectGroupId: 'group-1',
        path: '/repo/platform/hi/repo',
        executionHostId: 'runtime:env-a',
        connectionId: 'box'
      }
    ]
    mocks.state.projectGroups = [
      { id: 'group-1', executionHostId: 'runtime:env-a', connectionId: 'box' }
    ]
    expect(
      getRuntimeEnvironmentIdForFolderWorkspace(
        {
          folderWorkspaces: [
            makeFolderWorkspace({ id: 'folder', executionHostId: 'ssh:box', connectionId: 'box' })
          ],
          projectGroups: [],
          runtimeEnvironments: [{ id: ENV }]
        },
        'folder',
        'ssh:box'
      )
    ).toBe(ENV)
    const folderRun = { ...run, workspaceId: 'folder:folder' }
    input.local.selectedAutomationRuns.runs = [folderRun]
    pane('folder:folder', 'ssh:box', true)
    await mount(input, folderRun)
    current.open(folderRun)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    expect(mocks.activate).toHaveBeenCalledWith(
      'folder:folder',
      expect.objectContaining({ executionHostId: 'ssh:box', runtimeEnvironmentId: ENV })
    )
  })
  it('preserves inherited folder project-group SSH ownership on a native client', async () => {
    const input = seed([])
    const folder = makeFolderWorkspace({ id: 'folder', projectGroupId: 'group' })
    const group = {
      ...makeProjectGroup(),
      id: 'group',
      executionHostId: 'ssh:box' as const,
      connectionId: 'box'
    }
    mocks.state.folderWorkspaces = [folder]
    mocks.state.projectGroups = [group]
    expect(getFolderWorkspaceHostId(folder, [group])).toBe('ssh:box')
    const folderRun = { ...run, workspaceId: 'folder:folder' }
    input.local.selectedAutomationRuns.runs = [folderRun]
    pane('folder:folder', 'ssh:box')
    await mount(input, folderRun)
    current.open(folderRun)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    expect(mocks.activate).toHaveBeenCalledWith(
      'folder:folder',
      expect.objectContaining({ executionHostId: 'ssh:box' })
    )
  })
  it('opens a uniquely qualified workspace-only historical route and uses the fallback activation after exact reveal fails', async () => {
    const input = seed([worktree('local')])
    const workspaceOnly = { ...run, terminalPaneKey: null, terminalPtyId: null }
    input.local.selectedAutomationRuns.runs = [workspaceOnly]
    await mount(input, workspaceOnly)
    current.open(workspaceOnly)
    expect(mocks.activate).toHaveBeenCalledWith(WT, {
      executionHostId: 'local',
      runtimeEnvironmentId: null,
      providesInitialSurface: false
    })
    expect(mocks.toastMessage).toHaveBeenCalledWith('Workspace is available.')
    vi.clearAllMocks()
    mocks.activate.mockReturnValueOnce(false).mockReturnValue(true)
    pane(WT, 'local')
    await mount(input)
    current.open(run)
    expect(mocks.activate).toHaveBeenCalledTimes(2)
    expect(mocks.state.setActiveTab).not.toHaveBeenCalled()
  })
  it('preserves uniquely local legacy terminal rows and refuses catalog ambiguity without a pane owner', async () => {
    const input = seed([worktree('local')])
    pane(WT, 'local', false, false)
    await mount(input)
    expectOpen('local', TAB, null)
    mocks.state.worktreesByRepo = { 'repo-a': [worktree('local'), worktree('ssh:box')] }
    mocks.state.unifiedTabsByWorktree = {}
    mocks.state.terminalLayoutsByTabId = {}
    mocks.state.ptyIdsByTabId = {}
    input.local.selectedAutomationRuns.runs = [
      { ...run, runContext: null, terminalPaneKey: null, terminalPtyId: null }
    ]
    await mount(input, input.local.selectedAutomationRuns.runs[0])
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(false)
  })
  it('invalidates actions after captured owner or runtime pairing supersession', async () => {
    const input = seed([worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })], runtime)
    pane(WT, 'runtime:env-a', true)
    const render = await mount(input)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(true)
    mocks.state.runtimeEnvironments = [{ id: ENV, createdAt: 1, pairingRevision: 5 }]
    await render()
    current.open(run)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(false)
    expect(mocks.activate).not.toHaveBeenCalled()
    expect(mocks.ownerActivate).not.toHaveBeenCalled()
    mocks.state.runtimeEnvironments = [{ id: ENV, createdAt: 1, pairingRevision: 4 }]
    input.local.selectedAutomationRuns.ownerKey = 'another-owner'
    await render()
    current.open(run)
    expect(current.detail.selectedAutomationRunPageViewState?.canOpen).toBe(false)
  })
  it('retains per-run fallback names through missing catalog without borrowing a same-ID host name', async () => {
    const input = seed([worktree('local')])
    const unnamed = { ...run, workspaceDisplayName: null }
    input.local.selectedAutomationRuns.runs = [unnamed]
    const render = await mount(input, unnamed)
    expect(current.list.selectedAutomationRunsWithWorkspaceNames[0].workspaceDisplayName).toBe(
      'Live local'
    )
    mocks.state.worktreesByRepo = {}
    await render()
    expect(current.list.selectedAutomationRunsWithWorkspaceNames[0].workspaceDisplayName).toBe(
      'Live local'
    )
    const otherOwner = {
      owner: { authority: runtime, selector: { kind: 'self' as const } },
      selector: { kind: 'self' as const }
    }
    mocks.catalog.rows = {
      answered: true,
      rows: [input.selected],
      capturedOwners: new Map([[input.selected.key, otherOwner]])
    }
    input.local.selectedAutomationRuns = {
      ...input.local.selectedAutomationRuns,
      authority: runtime,
      ownerKey: capturedAutomationOwnerKey(otherOwner)
    }
    mocks.state.worktreesByRepo = {
      'repo-a': [
        worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV, displayName: 'Server name' })
      ]
    }
    await render()
    expect(current.list.selectedAutomationRunsWithWorkspaceNames[0].workspaceDisplayName).toBe(
      'Server name'
    )
  })

  it('asks the server to open a run whose pane it slept, PTY id dropped', async () => {
    const input = seed([worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })], runtime)
    const sleepingRun = { ...run, terminalPtyId: null }
    input.local.selectedAutomationRuns.runs = [sleepingRun]
    await mount(input, sleepingRun)
    current.open(sleepingRun)
    await vi.waitFor(() => expect(mocks.ownerActivate).toHaveBeenCalled())

    expect(mocks.activate).toHaveBeenCalledWith(
      WT,
      expect.objectContaining({ executionHostId: 'runtime:env-a', providesInitialSurface: true })
    )
    expect(mocks.ownerActivate).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WT, tabId: TAB, environmentId: ENV, leafId: LEAF })
    )
    expect(mocks.toastMessage).not.toHaveBeenCalled()
  })
})

function seedChat() {
  const input = seed(
    [worktree('local'), worktree('runtime:env-a', { runtimeOwnerEnvironmentId: ENV })],
    runtime
  )
  mocks.state.unifiedTabsByWorktree = { [WT]: mocks.chatTabs }
  mocks.state.activateTab = mocks.activateTab
  mocks.state.focusGroup = vi.fn()
  mocks.state.groupsByWorktree = {
    [WT]: [
      {
        ...makeTabGroup({ id: GROUP, worktreeId: WT }),
        get tabOrder() {
          return mocks.chatTabs.map((tab) => tab.id)
        },
        get activeTabId() {
          return mocks.chatTabs[0]?.id ?? null
        }
      }
    ]
  }
  mocks.state.activeGroupIdByWorktree = { [WT]: GROUP }
  return input
}

installAutomationChatRunCases({
  mocks,
  run,
  workspaceId: WT,
  environmentId: ENV,
  groupId: GROUP,
  seedChat,
  mount,
  open: (recorded) => current.open(recorded)
})
