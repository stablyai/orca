// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/constants'
import type { RuntimeHostStatusSnapshot } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/runtime-session-contracts'
import type * as WebRuntimeTerminalCreationModule from '../../hosted-terminals/creation/web-runtime-terminal-creation'

vi.mock('sonner', () => ({ toast: { warning: vi.fn(), dismiss: vi.fn() } }))

const mocks = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  ownerEnvironmentIdForWorkspace: vi.fn()
}))

vi.mock('../mirrored-workspace-owner', () => ({
  mirroredRuntimeEnvironmentIdForWorkspace: (state: unknown, workspaceId: string | null) =>
    workspaceId ? (mocks.ownerEnvironmentIdForWorkspace(state, workspaceId) ?? null) : null
}))

vi.mock('../../hosted-terminals/creation/web-runtime-terminal-creation', async (importOriginal) => {
  const actual = await importOriginal<typeof WebRuntimeTerminalCreationModule>()
  return {
    ...actual,
    createWebRuntimeSessionTerminal: mocks.createTerminal
  }
})

import { useAppStore } from '@/store/index'
import { replaceRuntimeEnvironmentRevisions } from '../../rpc/environment-revisions/runtime-environment-revision'
import { clearHostLiveTerminalProbesForTests } from '../../hosted-terminals/inventory/host-live-terminal-probe'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '../tracking-lifecycle'
import '../tracking'
import { useWebSessionTabsSync } from '../use-web-session-tabs-sync'
import { clearRuntimeEnvironmentConnectionGenerations as clearRuntimeEnvironmentConnectionGenerationsForTests } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { resetWebRuntimeInitialTerminalBootstrapForTests } from '../initial-terminal/web-runtime-initial-terminal-bootstrap'
import { publicRuntimeEnvironment } from '../../rpc/testing/paired-runtime-environment-test-fixture'

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
