// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { RuntimeHostStatusSnapshot } from '../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeMobileSessionTabsResult, RuntimeStatus } from '../../../shared/runtime-types'
import type * as WebRuntimeTerminalCreationModule from './hosted-terminals/creation/web-runtime-terminal-creation'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn()
}))

vi.mock('./web-session-tabs-sync/mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

vi.mock('./hosted-terminals/creation/web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  return {
    ...actual,
    createWebRuntimeSessionTerminal: mocks.createTerminal
  }
})

import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from './rpc/environment-revisions/runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from './hosted-terminals/inventory/host-live-terminal-probe'
import { resetWebSessionTabsSnapshotFreshnessForTests } from './web-session-tabs-sync/tracking-lifecycle'
import './web-session-tabs-sync/tracking'
import { useWebSessionTabsSync } from './web-session-tabs-sync/use-web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from './web-session-tabs-sync/initial-terminal/web-runtime-initial-terminal-bootstrap'
import { TERMINAL_WORKTREE_HOT_RETAIN_LIMIT } from '@/components/terminal-pane/parking/retention/terminal-hidden-view-parking'
import { publicRuntimeEnvironment } from './rpc/testing/paired-runtime-environment-test-fixture'

const ENV = 'env-a'
const WORKTREE_A = 'repo-a::worktree-a'
const WORKTREE_B = 'repo-a::worktree-b'
const REVISION = 101
const initialState = useAppStore.getInitialState()

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type Recorded = {
  request: Parameters<RuntimeSubscribe>[0]
  callbacks: Parameters<RuntimeSubscribe>[1]
  unsubscribe: ReturnType<typeof vi.fn>
}

const subscriptions: Recorded[] = []
const runtimeCall = vi.fn(async () => ({
  id: 'list-all',
  ok: true as const,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}))
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  const unsubscribe = vi.fn()
  subscriptions.push({ request, callbacks, unsubscribe })
  return { unsubscribe, sendBinary: vi.fn() }
})

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await Promise.resolve()
  }
}

function makeStatus(): RuntimeStatus {
  return {
    runtimeId: 'runtime-a',
    rendererGraphEpoch: 0,
    graphStatus: 'ready',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function hostSnapshot(
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
): RuntimeHostStatusSnapshot {
  return {
    environmentId: ENV,
    pairingRevision: REVISION,
    sequence,
    checkedAt: sequence,
    status: makeStatus(),
    verification: 'verified',
    transport: 'ready',
    ...patch
  }
}

function worktreeStreams(worktreeId?: string): Recorded[] {
  return subscriptions.filter(
    (entry) =>
      entry.request.method === 'session.tabs.subscribe' &&
      (worktreeId === undefined || JSON.stringify(entry.request.params).includes(worktreeId))
  )
}

function latestStream(worktreeId: string): Recorded {
  const stream = worktreeStreams(worktreeId).at(-1)
  if (!stream) {
    throw new Error(`no stream for ${worktreeId}`)
  }
  return stream
}

function allWorktreesStreams(): Recorded[] {
  return subscriptions.filter((entry) => entry.request.method === 'session.tabs.subscribeAll')
}

function terminalSnapshot(
  worktree: string,
  snapshotVersion: number
): RuntimeMobileSessionTabsResult {
  return {
    worktree,
    publicationEpoch: 'epoch-1',
    snapshotVersion,
    activeGroupId: 'host-tab-1',
    activeTabId: 'host-tab-1::leaf-1',
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: 'host-tab-1::leaf-1',
        parentTabId: 'host-tab-1',
        leafId: 'leaf-1',
        title: 'Terminal 1',
        terminal: 'term_host',
        status: 'ready',
        isActive: true
      }
    ]
  }
}

async function publish(stream: Recorded, result: unknown): Promise<void> {
  await act(async () => {
    stream.callbacks.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-a' }
    })
    await settle()
  })
}

async function selectWorktree(worktreeId: string): Promise<void> {
  await act(async () => {
    useAppStore.setState({ activeWorktreeId: worktreeId })
    await settle()
  })
}

async function connect(): Promise<void> {
  renderHook(() => useWebSessionTabsSync())
  await act(async () => {
    useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(1))
    await settle()
  })
}

describe('session-tabs streams across worktree switches on one host', () => {
  beforeEach(() => {
    subscriptions.length = 0
    runtimeCall.mockClear()
    runtimeSubscribe.mockClear()
    mocks.createTerminal.mockReset().mockResolvedValue({ status: 'created' })
    mocks.ownerEnvironmentIdForWorkspace.mockReset().mockReturnValue(ENV)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe }
      }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    clearHostLiveTerminalProbesForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
    const runtimeEnvironments = [
      publicRuntimeEnvironment({ id: ENV, createdAt: 100, pairingRevision: REVISION })
    ]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        settings: {
          ...getDefaultSettings('/tmp'),
          activeRuntimeEnvironmentId: ENV
        },
        activeWorktreeId: WORKTREE_A,
        workspaceSessionReady: true,
        runtimeEnvironments,
        runtimeStatusByEnvironmentId: new Map()
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    resetWebRuntimeInitialTerminalBootstrapForTests()
    clearRuntimeEnvironmentConnectionGenerationsForTests()
  })

  it('keeps one stream per worktree while cycling the mounted-terminal working set', async () => {
    await connect()
    const installed = worktreeStreams().length
    const closed = (): number =>
      worktreeStreams().filter((stream) => stream.unsubscribe.mock.calls.length > 0).length
    const closedBefore = closed()
    const cycle = [WORKTREE_A, ...['b', 'c', 'd', 'e'].map((id) => `repo-a::worktree-${id}`)]
    expect(cycle).toHaveLength(1 + TERMINAL_WORKTREE_HOT_RETAIN_LIMIT)

    for (let round = 0; round < 4; round += 1) {
      for (const worktreeId of cycle) {
        await selectWorktree(worktreeId)
      }
    }

    // Before the pool matched the retained set, every switch around five worktrees resubscribed.
    expect(worktreeStreams()).toHaveLength(installed + cycle.length - 1)
    expect(closed()).toBe(closedBefore)
  })

  it('seeds the first terminal once the user returns to a warm empty worktree', async () => {
    await connect()
    const streamA = latestStream(WORKTREE_A)
    await selectWorktree(WORKTREE_B)
    // A's first answer lands while B is selected, so its bootstrap waits.
    await publish(streamA, {
      type: 'snapshot',
      ...terminalSnapshot(WORKTREE_A, 1),
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null,
      tabs: []
    })
    expect(mocks.createTerminal).not.toHaveBeenCalled()

    await selectWorktree(WORKTREE_A)

    expect(latestStream(WORKTREE_A)).toBe(streamA)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
    expect(mocks.createTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_A, environmentId: ENV })
    )
    await selectWorktree(WORKTREE_B)
    await selectWorktree(WORKTREE_A)
    expect(mocks.createTerminal).toHaveBeenCalledTimes(1)
  })

  it('drops a warm stream when its host is re-paired while another host is selected', async () => {
    await connect()
    const streamA = latestStream(WORKTREE_A)
    mocks.ownerEnvironmentIdForWorkspace.mockImplementation((_state, worktreeId) =>
      worktreeId === WORKTREE_B ? 'env-b' : ENV
    )
    const withHostB = [
      ...useAppStore.getState().runtimeEnvironments,
      publicRuntimeEnvironment({ id: 'env-b', createdAt: 200, pairingRevision: 201 })
    ]
    replaceRuntimeEnvironmentRevisions(withHostB)
    await act(async () => {
      useAppStore.setState({ runtimeEnvironments: withHostB })
      await settle()
    })
    await selectWorktree(WORKTREE_B)
    expect(streamA.unsubscribe).not.toHaveBeenCalled()

    const repaired = withHostB.map((environment) =>
      environment.id === ENV ? { ...environment, pairingRevision: REVISION + 1 } : environment
    )
    replaceRuntimeEnvironmentRevisions(repaired)
    await act(async () => {
      useAppStore.setState({ runtimeEnvironments: repaired })
      await settle()
    })

    expect(streamA.unsubscribe).toHaveBeenCalled()
  })

  it('keeps live streams when a status probe flaps without the streams ending', async () => {
    await connect()
    const before = {
      worktree: worktreeStreams().length,
      all: allWorktreesStreams().length
    }
    const live = subscriptions.filter((stream) => stream.unsubscribe.mock.calls.length === 0)

    await act(async () => {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(hostSnapshot(2, { verification: 'unavailable' }))
      await settle()
    })
    await act(async () => {
      useAppStore.getState().applyRuntimeHostStatusSnapshot(hostSnapshot(3))
      await settle()
    })

    expect(useAppStore.getState().runtimeStatusByEnvironmentId.get(ENV)?.hostContactEpoch).toBe(1)
    expect(worktreeStreams()).toHaveLength(before.worktree)
    expect(allWorktreesStreams()).toHaveLength(before.all)
    for (const stream of live) {
      expect(stream.unsubscribe).not.toHaveBeenCalled()
    }
  })

  it('drops warm streams once the host returns as a new runtime session', async () => {
    await connect()
    await selectWorktree(WORKTREE_B)
    const streamA = latestStream(WORKTREE_A)
    const streamB = latestStream(WORKTREE_B)

    await act(async () => {
      useAppStore
        .getState()
        .applyRuntimeHostStatusSnapshot(hostSnapshot(2, { verification: 'unavailable' }))
      useAppStore.getState().applyRuntimeHostStatusSnapshot(
        hostSnapshot(3, {
          status: { ...makeStatus(), runtimeId: 'runtime-b' }
        })
      )
      await settle()
    })

    expect(streamA.unsubscribe).toHaveBeenCalled()
    expect(streamB.unsubscribe).toHaveBeenCalled()
    expect(latestStream(WORKTREE_B)).not.toBe(streamB)
    await selectWorktree(WORKTREE_A)
    expect(latestStream(WORKTREE_A)).not.toBe(streamA)
  })
})
