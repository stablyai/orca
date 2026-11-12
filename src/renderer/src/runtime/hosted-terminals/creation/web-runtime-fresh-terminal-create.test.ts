import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { createStoreSessionMockApi } from '../../../store/testing/app-store-session-api.test-fixture'

const mocks = vi.hoisted(
  (): { store: ReturnType<typeof createTestStore> | null } & Record<
    | 'call'
    | 'proof'
    | 'supports'
    | 'focus'
    | 'select'
    | 'settle'
    | 'current'
    | 'ownerCurrent'
    | 'paneFocus'
    | 'notice',
    ReturnType<typeof vi.fn>
  > => ({
    store: null,
    call: vi.fn(),
    proof: vi.fn(),
    supports: vi.fn(),
    focus: vi.fn(),
    select: vi.fn(),
    settle: vi.fn(),
    current: vi.fn(),
    ownerCurrent: vi.fn(),
    paneFocus: vi.fn(),
    notice: vi.fn()
  })
)
function store() {
  if (!mocks.store) {
    throw new Error('Missing test store')
  }
  return mocks.store
}
vi.mock('@/store/index', () => ({
  useAppStore: {
    getState: () => store().getState(),
    setState: (...args: Parameters<ReturnType<typeof createTestStore>['setState']>) =>
      store().setState(...args),
    subscribe: (...args: Parameters<ReturnType<typeof createTestStore>['subscribe']>) =>
      store().subscribe(...args)
  }
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: mocks.notice } }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.call }))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentCapabilityProof: mocks.proof,
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/store/terminals/terminal-creation-navigation', () => ({
  captureTerminalCreationNavigation: () => ({ current: mocks.current, dispose: vi.fn() }),
  focusAcceptedTerminalPane: mocks.paneFocus
}))
vi.mock('../../web-session-tabs-sync/identity/web-runtime-session-environment', () => ({
  captureRuntimeEnvironmentCall: () => vi.fn(),
  captureWebSessionIntentOwner: () => ({ environmentId: 'paired', pairingRevision: 7 }),
  isWebRuntimeSessionActive: () => true,
  matchesWebSessionIntentOwner: mocks.ownerCurrent
}))
vi.mock(
  '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-routing',
  () => ({ resolveWebRuntimeSessionEnvironmentId: () => 'paired' })
)
vi.mock(
  '../../web-session-tabs-sync/workspace-selection/web-runtime-session-workspace-selection',
  () => ({
    readActiveWorkspaceSelection: vi.fn(),
    restoreActiveWorkspaceSelection: vi.fn(),
    selectWebRuntimeSessionWorktree: mocks.select
  })
)
vi.mock(
  '../../web-session-tabs-sync/navigation/web-session-focus-intent',
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    recordWebSessionFocusIntent: mocks.focus
  })
)
vi.mock('../../web-session-tabs-sync/inventory/web-runtime-session-snapshot', () => ({
  refreshWebRuntimeSessionTabsSnapshot: vi.fn(async () => {})
}))
vi.mock('../placement/web-runtime-terminal-placement-settlement', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  settleWebRuntimeTerminalPlacement: mocks.settle
}))

import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { createWebRuntimeSessionTerminalOnHost } from './web-runtime-terminal-creation'
import { acceptSessionTabsRuntimeId } from '../../web-session-tabs-sync/publisher-identity-fences'
import { sessionTabsRuntimeHistoryByEnvironment } from '../../web-session-tabs-sync/state'
import { toWebTerminalSurfaceTabId } from '../../../../../shared/workspace-layout/terminal-surface-id'
import { createWebRuntimeSessionTerminalResult } from './web-runtime-terminal-create-operation'
import {
  splitPaneInMain,
  splitServerPane,
  type SplitInMainRequest
} from '../../../components/terminal-pane/layout/split/terminal-pane-split-in-main'
import { resolveTerminalPaneOwnerContext } from '../../../components/terminal-pane/host-state/terminal-pane-owner-context'
import type { Repo } from '../../../../../shared/repo-types'
import {
  createDeferred,
  flushAsyncTicks
} from '../../../components/terminal-pane/pty-connection/test-fixtures/pty-connection-test-async'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import {
  clearHostSessionTabIdMappings,
  setHostSessionTabIdMapping
} from '../../web-session-tabs-sync/tracking-mappings'
import { runtimeOwnedRepoState } from '../../../store/repos/repo.test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'

const WORKTREE = 'repo1::/repo1/main'
beforeEach(() => {
  vi.clearAllMocks()
  createStoreSessionMockApi()
  mocks.store = createTestStore()
  seedStore(store(), {
    activeWorktreeId: WORKTREE,
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'source', worktreeId: WORKTREE, tabOrder: [], activeTabId: null }]
    },
    layoutByWorktree: { [WORKTREE]: { type: 'leaf', groupId: 'source' } },
    activeGroupIdByWorktree: { [WORKTREE]: 'source' }
  })
  mocks.proof.mockResolvedValue({ supported: true, runtimeId: 'runtime-7', pairingRevision: 7 })
  mocks.supports.mockResolvedValue(true)
  mocks.current.mockReturnValue(true)
  mocks.ownerCurrent.mockReturnValue(true)
  sessionTabsRuntimeHistoryByEnvironment.clear()
  acceptSessionTabsRuntimeId('paired', 'runtime-7')
  mocks.settle.mockResolvedValue(undefined)
})

describe('paired fresh terminal admission placement', () => {
  it('does not publish a requested split group or change selection on host refusal', async () => {
    const before = store().getState()
    mocks.call.mockRejectedValueOnce(new Error('Open a checkout to start a terminal.'))
    const result = await createWebRuntimeSessionTerminalResult({
      worktreeId: WORKTREE,
      environmentId: 'paired',
      split: { besideGroupId: 'source', direction: 'right' },
      activate: true
    })
    expect(result.outcome.status).toBe('failed')
    expect(store().getState().groupsByWorktree).toBe(before.groupsByWorktree)
    expect(store().getState().layoutByWorktree).toBe(before.layoutByWorktree)
    expect(mocks.select).not.toHaveBeenCalled()
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledOnce()
  })

  it('forwards capable-host placement and startup facts, then projects the accepted group without stealing later selection', async () => {
    mocks.current.mockReturnValue(false)
    mocks.call.mockResolvedValueOnce({ tab: { id: 'host-tab', leafId: 'host-leaf' } })
    const result = await createWebRuntimeSessionTerminalResult({
      worktreeId: WORKTREE,
      environmentId: 'paired',
      clientMutationId: 'fresh-operation',
      shell: 'powershell.exe',
      cwd: 'C:/repo/sub',
      command: 'echo "a  b"',
      env: { MODE: 'fresh' },
      envToDelete: ['OLD'],
      startupCommandDelivery: 'shell-ready',
      initialSize: { cols: 90, rows: 40 },
      split: { besideGroupId: 'source', direction: 'right' },
      activate: true
    })
    expect(result.outcome.status).toBe('created')
    expect(mocks.call).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'paired' },
      'session.tabs.createTerminal',
      expect.objectContaining({
        clientMutationId: 'fresh-operation',
        shell: 'powershell.exe',
        cwd: 'C:/repo/sub',
        command: 'echo "a  b"',
        env: { MODE: 'fresh' },
        envToDelete: ['OLD'],
        startupCommandDelivery: 'shell-ready',
        initialSize: { cols: 90, rows: 40 },
        split: { besideGroupId: 'source', direction: 'right' },
        activate: false,
        navigation: 'caller'
      }),
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: 7,
        expectedEnvironmentRuntimeId: 'runtime-7'
      }
    )
    const target = mocks.call.mock.calls[0][2].targetGroupId
    expect(
      store()
        .getState()
        .groupsByWorktree[WORKTREE].map((group) => group.id)
    ).toEqual(['source', target])
    expect(mocks.settle).toHaveBeenCalledWith(
      'paired',
      WORKTREE,
      'host-tab',
      expect.objectContaining({ groupId: target, activate: false })
    )
    expect(mocks.focus).not.toHaveBeenCalled()
    expect(mocks.select).not.toHaveBeenCalled()
  })

  it('chooses the legacy shell/group route before dispatch and does not send another create after a lost reply', async () => {
    mocks.proof.mockResolvedValueOnce({
      supported: false,
      runtimeId: 'old-runtime',
      pairingRevision: 7
    })
    mocks.supports.mockResolvedValueOnce(false)
    mocks.call.mockRejectedValueOnce(new Error('Disconnected before reply'))
    const result = await createWebRuntimeSessionTerminalResult({
      worktreeId: WORKTREE,
      environmentId: 'paired',
      shell: 'powershell.exe',
      initialSize: { cols: 90, rows: 40 },
      split: { besideGroupId: 'source', direction: 'right' },
      activate: true
    })
    expect(result.outcome.status).toBe('failed')
    expect(mocks.call).toHaveBeenCalledOnce()
    expect(mocks.call.mock.calls[0][2]).toEqual(
      expect.objectContaining({ command: 'powershell.exe', targetGroupId: expect.any(String) })
    )
    expect(mocks.call.mock.calls[0][2]).not.toHaveProperty('split')
    expect(mocks.call.mock.calls[0][2]).not.toHaveProperty('initialSize')
  })
})

function retainedCreateError(changes: Record<string, unknown> = {}) {
  return new RuntimeRpcCallError({
    id: 'create',
    ok: false,
    error: {
      code: 'runtime_error',
      message: 'The selected shell could not start.',
      data: {
        retainedTerminalStart: {
          worktreeId: WORKTREE,
          executionHostId: 'local',
          runtimeId: 'runtime-7',
          tabId: 'host-retained',
          leafId: '11111111-1111-4111-8111-111111111111',
          bindingGeneration: 0,
          startSequence: 1,
          status: 'failed',
          reason: 'The selected shell could not start.',
          ...changes
        }
      }
    }
  })
}

it.each([
  'current',
  'later navigation',
  'foreign runtime',
  're-paired',
  'retired publisher',
  'different selected host'
] as const)(
  'keeps the source host after workspace selection changes and qualifies its raw retained split: %s',
  async (answer) => {
    const mirror = toWebTerminalSurfaceTabId('host-retained')
    const sourceLeafId = '22222222-2222-4222-8222-222222222222'
    seedStore(
      store(),
      runtimeOwnedRepoState('paired', 'repo1', '/repo1', {
        activeWorkspaceExecutionHostId: 'runtime:paired',
        worktreesByRepo: {
          repo1: [
            makeWorktree({
              id: WORKTREE,
              repoId: 'repo1',
              path: '/repo1/main',
              hostId: 'runtime:paired'
            })
          ]
        }
      })
    )
    store()
      .getState()
      .createTab(WORKTREE, 'source', undefined, {
        id: mirror,
        initialLeafId: sourceLeafId,
        mirroredHostTab: true,
        activate: false,
        layoutAlreadyAdmitted: true,
        initialPtyId:
          answer === 'different selected host' ? 'remote:paired@@source-terminal' : undefined,
        executionFacts:
          answer === 'different selected host'
            ? {
                hostId: 'runtime:paired',
                connectionId: null,
                platform: 'linux',
                isRemote: true,
                isWsl: false
              }
            : undefined
      })
    if (answer === 'different selected host') {
      store().setState({ activeWorkspaceExecutionHostId: 'runtime:rival' })
    }
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 7 }])
    setHostSessionTabIdMapping(
      { environmentId: 'paired', worktreeId: WORKTREE, tabId: mirror },
      'host-retained'
    )
    const reply = createDeferred<never>()
    mocks.call.mockReturnValueOnce(reply.promise)
    try {
      expect(
        splitPaneInMain(
          { worktreeId: WORKTREE, tabId: mirror, sourceLeafId, direction: 'vertical' },
          vi.fn()
        )
      ).toBe(false)
      expect(
        splitServerPane({
          worktreeId: WORKTREE,
          tabId: mirror,
          sourceLeafId,
          direction: 'vertical'
        })
      ).toBe(true)
      await flushAsyncTicks()
      expect(mocks.call).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'paired' },
        'terminal.split',
        expect.objectContaining({
          pane: { worktreeId: WORKTREE, tabId: 'host-retained', leafId: sourceLeafId },
          newLeafId: expect.any(String),
          direction: 'vertical',
          activate: false
        }),
        { expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'runtime-7' }
      )
      const { newLeafId } = mocks.call.mock.calls[0][2]
      mocks.current.mockReturnValue(answer !== 'later navigation')
      if (answer === 're-paired') {
        replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 8 }])
        mocks.ownerCurrent.mockReturnValue(false)
      }
      if (answer === 'retired publisher') {
        acceptSessionTabsRuntimeId('paired', 'successor-runtime')
      }
      reply.reject(
        retainedCreateError({
          leafId: newLeafId,
          ...(answer === 'foreign runtime' ? { runtimeId: 'foreign-runtime' } : {})
        })
      )
      await flushAsyncTicks()
      const accepted =
        answer === 'current' ||
        answer === 'later navigation' ||
        answer === 'different selected host'
      if (!accepted) {
        expect(store().getState().terminalLayoutsByTabId[mirror].root).toEqual({
          type: 'leaf',
          leafId: sourceLeafId
        })
        expect(store().getState().terminalPaneStartsByPaneKey).toEqual({})
        expect(mocks.paneFocus).not.toHaveBeenCalled()
        expect(mocks.notice).toHaveBeenCalledOnce()
        expect(mocks.call).toHaveBeenCalledOnce()
        return
      }
      expect(store().getState().terminalLayoutsByTabId[mirror].root).toMatchObject({
        type: 'split',
        direction: 'vertical',
        first: { type: 'leaf', leafId: sourceLeafId },
        second: { type: 'leaf', leafId: newLeafId }
      })
      expect(
        store().getState().terminalPaneStartsByPaneKey[`${mirror}:${newLeafId}`]
      ).toMatchObject({
        status: 'failed',
        retainedTerminalStart: { tabId: 'host-retained', leafId: newLeafId }
      })
      expect(store().getState().tabsByWorktree[WORKTREE]).toHaveLength(1)
      if (answer !== 'later navigation') {
        expect(mocks.paneFocus).toHaveBeenCalledExactlyOnceWith(mirror, newLeafId)
      } else {
        expect(mocks.paneFocus).not.toHaveBeenCalled()
      }
      expect(mocks.notice).not.toHaveBeenCalled()
      expect(mocks.call).toHaveBeenCalledOnce()
    } finally {
      clearHostSessionTabIdMappings('paired', WORKTREE)
      replaceRuntimeEnvironmentRevisions([])
    }
  }
)

it('projects an authenticated raw retained create into one mirrored pane with caller placement and one failure presentation', async () => {
  mocks.call.mockRejectedValueOnce(retainedCreateError())
  const mirror = toWebTerminalSurfaceTabId('host-retained')
  const observed: string[] = []
  const stop = store().subscribe((state) => {
    if (state.tabsByWorktree[WORKTREE]?.some((tab) => tab.id === mirror)) {
      expect(
        state.terminalPaneStartsByPaneKey[`${mirror}:11111111-1111-4111-8111-111111111111`]?.status
      ).toBe('failed')
      observed.push(mirror)
    }
  })
  const result = await createWebRuntimeSessionTerminalOnHost({
    worktreeId: WORKTREE,
    environmentId: 'paired',
    shell: 'powershell.exe',
    cwd: 'C:/repo/sub',
    split: { besideGroupId: 'source', direction: 'down' },
    activate: true
  })
  stop()
  expect(result.status).toBe('retained')
  expect(observed.length).toBeGreaterThan(0)
  const target = mocks.call.mock.calls[0][2].targetGroupId
  expect(store().getState().tabsByWorktree[WORKTREE]).toEqual([
    expect.objectContaining({
      id: mirror,
      shellOverride: 'powershell.exe',
      startupCwd: 'C:/repo/sub'
    })
  ])
  expect(store().getState().unifiedTabsByWorktree[WORKTREE]).toEqual([
    expect.objectContaining({ entityId: mirror, groupId: target })
  ])
  expect(store().getState().layoutByWorktree[WORKTREE]).toMatchObject({
    type: 'split',
    direction: 'vertical',
    first: { groupId: 'source' },
    second: { groupId: target }
  })
  expect(mocks.paneFocus).toHaveBeenCalledWith(mirror, '11111111-1111-4111-8111-111111111111')
  expect(mocks.notice).not.toHaveBeenCalled()
  expect(mocks.call).toHaveBeenCalledOnce()
})

it('keeps a later navigation when projecting a valid retained paired reply', async () => {
  mocks.current.mockReturnValue(false)
  mocks.call.mockRejectedValueOnce(retainedCreateError())
  const result = await createWebRuntimeSessionTerminalOnHost({
    worktreeId: WORKTREE,
    environmentId: 'paired',
    targetGroupId: 'source',
    activate: true
  })
  expect(result.status).toBe('retained')
  expect(store().getState().tabsByWorktree[WORKTREE]).toHaveLength(1)
  expect(mocks.paneFocus).not.toHaveBeenCalled()
  expect(mocks.select).not.toHaveBeenCalled()
  expect(mocks.notice).not.toHaveBeenCalled()
  expect(mocks.call).toHaveBeenCalledOnce()
})

it.each(['workspace', 'runtime', 'pairing', 'retired publisher'] as const)(
  'rejects a retained paired response with a foreign %s',
  async (foreign) => {
    mocks.call.mockImplementationOnce(async () => {
      if (foreign === 'pairing') {
        mocks.ownerCurrent.mockReturnValue(false)
      }
      if (foreign === 'retired publisher') {
        acceptSessionTabsRuntimeId('paired', 'successor-runtime')
      }
      throw retainedCreateError(
        foreign === 'workspace'
          ? { worktreeId: 'other-workspace' }
          : foreign === 'runtime'
            ? { runtimeId: 'other-runtime' }
            : {}
      )
    })
    const result = await createWebRuntimeSessionTerminalOnHost({
      worktreeId: WORKTREE,
      environmentId: 'paired',
      targetGroupId: 'source'
    })
    expect(result.status).toBe('failed')
    expect(store().getState().tabsByWorktree[WORKTREE] ?? []).toEqual([])
    expect(store().getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(mocks.paneFocus).not.toHaveBeenCalled()
    expect(mocks.call).toHaveBeenCalledOnce()
  }
)

it.each([12, 120])(
  'keeps mapped source splits addressed after warming %i repositories and preserves exact row candidates',
  async (repoCount) => {
    const sourceRepo: Repo = {
      id: 'repo1',
      path: '/repo1',
      displayName: 'Source repository',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'runtime:paired',
      worktreeBasePath: '../worktrees'
    }
    const localTwin: Repo = { ...sourceRepo, path: '/local/repo1', executionHostId: 'local' }
    let unrelatedReads = 0
    const unrelated = Array.from({ length: repoCount - 2 }, (_, index): Repo => ({
      get id() {
        unrelatedReads += 1
        return `unrelated-${index}`
      },
      path: `/unrelated-${index}`,
      displayName: 'Unrelated repository',
      badgeColor: '',
      addedAt: 0,
      executionHostId: 'local'
    }))
    const repos = [sourceRepo, localTwin, ...unrelated]
    seedStore(store(), {
      repos,
      activeWorkspaceExecutionHostId: 'runtime:paired',
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE,
            repoId: 'repo1',
            path: '/repo1/main',
            hostId: 'runtime:paired'
          })
        ]
      }
    })
    const mirror = toWebTerminalSurfaceTabId('host-retained')
    const sourceLeafId = '22222222-2222-4222-8222-222222222222'
    store()
      .getState()
      .createTab(WORKTREE, 'source', undefined, {
        id: mirror,
        initialLeafId: sourceLeafId,
        mirroredHostTab: true,
        layoutAlreadyAdmitted: true,
        activate: false,
        executionFacts: {
          hostId: 'runtime:paired',
          connectionId: null,
          platform: 'linux',
          isRemote: true,
          isWsl: false
        }
      })
    store().setState({ activeWorkspaceExecutionHostId: 'runtime:rival' })
    const sourceUnifiedTabs = store().getState().unifiedTabsByWorktree
    const request: SplitInMainRequest = {
      worktreeId: WORKTREE,
      tabId: mirror,
      sourceLeafId,
      direction: 'vertical'
    }
    const readOwner = () => {
      const state = store().getState()
      return resolveTerminalPaneOwnerContext(
        state,
        WORKTREE,
        mirror,
        null,
        state.terminalLayoutsByTabId[mirror]?.ptyIdsByLeafId?.[sourceLeafId]
      )
    }
    replaceRuntimeEnvironmentRevisions([{ id: 'paired', createdAt: 7 }])
    setHostSessionTabIdMapping(
      { environmentId: 'paired', worktreeId: WORKTREE, tabId: mirror },
      'host-retained'
    )
    mocks.call.mockResolvedValue({
      split: { handle: 'accepted-split', tabId: 'host-retained', paneRuntimeId: 41 }
    })
    const split = async () => {
      expect(splitPaneInMain(request, vi.fn())).toBe(false)
      expect(splitServerPane(request)).toBe(true)
      await flushAsyncTicks()
      expect(mocks.call).toHaveBeenLastCalledWith(
        { kind: 'environment', environmentId: 'paired' },
        'terminal.split',
        expect.objectContaining({
          pane: { worktreeId: WORKTREE, tabId: 'host-retained', leafId: sourceLeafId }
        }),
        { expectedEnvironmentPairingRevision: 7, expectedEnvironmentRuntimeId: 'runtime-7' }
      )
    }
    try {
      await split()
      expect(unrelatedReads).toBeGreaterThan(0)
      const warmedReads = unrelatedReads
      await split()
      await split()
      expect(unrelatedReads).toBe(warmedReads)
      expect(mocks.call).toHaveBeenCalledTimes(3)
      expect(readOwner().repo).toBe(sourceRepo)
      expect(readOwner().repo?.worktreeBasePath).toBe('../worktrees')
      expect(readOwner().projectRuntimeTarget?.repo).toBe(sourceRepo)

      store().setState({ repos: [sourceRepo, { ...sourceRepo }, localTwin, ...unrelated] })
      expect(readOwner().repo).toBeUndefined()
      expect(readOwner().projectRuntimeTarget).toBeUndefined()
      expect(readOwner().runtimeEnvironmentId).toBe('paired')
      store().setState({ repos: unrelated })
      expect(readOwner().repo).toBeUndefined()
      expect(readOwner().projectRuntimeTarget).toBeUndefined()

      store().setState({
        repos,
        unifiedTabsByWorktree: {
          ...sourceUnifiedTabs,
          [WORKTREE]: sourceUnifiedTabs[WORKTREE].map((tab): typeof tab => ({
            ...tab,
            executionHostId: undefined
          }))
        }
      })
      expect(readOwner().repo).toBeUndefined()
      store().setState({
        unifiedTabsByWorktree: {
          ...sourceUnifiedTabs,
          [WORKTREE]: sourceUnifiedTabs[WORKTREE].map((tab): typeof tab => ({
            ...tab,
            executionHostId: 'runtime:'
          }))
        }
      })
      expect(readOwner().unresolved).toBe(true)
      store().setState({ unifiedTabsByWorktree: sourceUnifiedTabs })
      const layout = store().getState().terminalLayoutsByTabId[mirror]
      store()
        .getState()
        .setTabLayout(mirror, {
          ...layout,
          ptyIdsByLeafId: { [sourceLeafId]: 'remote:rival@@foreign-terminal' }
        })
      expect(readOwner().unresolved).toBe(true)
      expect(splitPaneInMain(request, vi.fn())).toBe(true)
      expect(splitServerPane(request)).toBe(false)
      expect(mocks.call).toHaveBeenCalledTimes(3)
    } finally {
      clearHostSessionTabIdMappings('paired', WORKTREE)
      replaceRuntimeEnvironmentRevisions([])
    }
  }
)
