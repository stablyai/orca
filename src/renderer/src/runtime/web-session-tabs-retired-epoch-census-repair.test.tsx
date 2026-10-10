// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { PublicKnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import type { AppState } from '@/store/types'
import type * as WorktreeRuntimeOwnerModule from '@/lib/worktree-runtime-owner'

const mocks = vi.hoisted(() => ({
  getExplicitRuntimeEnvironmentIdForWorktree: vi.fn()
}))

vi.mock('./use-runtime-session-mirror-environment-key', () => ({
  useRuntimeSessionMirrorEnvironmentKeys: () => ({
    environmentKey: `env-a\u0001runtime-a\u00011\u0001101`,
    resubscribeSignal: ''
  })
}))
vi.mock('@/lib/worktree-runtime-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRuntimeOwnerModule>()
  return {
    ...actual,
    getExplicitRuntimeEnvironmentIdForWorktree: mocks.getExplicitRuntimeEnvironmentIdForWorktree
  }
})
vi.mock('./web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (_state: unknown, snapshot: unknown) =>
    snapshot
}))

import { useAppStore } from '@/store'
import { replaceRuntimeEnvironmentRevisions } from './runtime-environment-revision'
import {
  resetWebSessionTabsSnapshotFreshnessForTests,
  useWebSessionTabsSync
} from './web-session-tabs-sync'

/**
 * #21928: a paired host mints `headless:` epochs for one worktree between renderer frames, so the
 * renderer publisher returning (R → H → R) looked retired and its new tabs were dropped for good.
 */
const ENV_A = 'env-a'
const WORKTREE = 'repo-a::worktree-a'
const RENDERER_EPOCH = 'renderer:53c8f87d'
const HEADLESS_EPOCH = 'headless:mgx1'
const LEAF_A = '11111111-1111-4111-8111-111111111111'
const LEAF_B = '22222222-2222-4222-8222-222222222222'
const initialState = useAppStore.getInitialState()
type TerminalTab = Extract<RuntimeMobileSessionTabsResult['tabs'][number], { type: 'terminal' }>

type RuntimeSubscribe = typeof window.api.runtimeEnvironments.subscribe
type RuntimeCallResult = Awaited<ReturnType<typeof window.api.runtimeEnvironments.call>>
const streams: Parameters<RuntimeSubscribe>[1][] = []
let census: RuntimeCallResult = {
  id: 'list-all',
  ok: true,
  result: { snapshots: [] },
  _meta: { runtimeId: 'runtime-a' }
}
let censusGate: Promise<void> = Promise.resolve()
const runtimeCall = vi.fn(async () => {
  await censusGate
  return census
})
const runtimeSubscribe = vi.fn<RuntimeSubscribe>(async (request, callbacks) => {
  if (request.method === 'session.tabs.subscribeAll') {
    streams.push(callbacks)
  }
  return { unsubscribe: vi.fn(), sendBinary: vi.fn() }
})

function terminal(suffix: 'a' | 'b'): TerminalTab {
  return {
    type: 'terminal',
    id: `host-surface-${suffix}`,
    parentTabId: `host-tab-${suffix}`,
    leafId: suffix === 'a' ? LEAF_A : LEAF_B,
    title: `Terminal ${suffix}`,
    status: 'ready',
    terminal: `terminal-${suffix}`,
    isActive: suffix === 'a'
  }
}

function frame(
  publicationEpoch: string,
  snapshotVersion: number,
  tabs: TerminalTab[]
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE,
    publicationEpoch,
    snapshotVersion,
    activeGroupId: null,
    activeTabId: 'host-surface-a',
    activeTabType: 'terminal',
    tabs
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

async function publish(result: unknown): Promise<void> {
  await act(async () => {
    streams.at(-1)?.onResponse({
      id: 'subscription-event',
      ok: true,
      result,
      _meta: { runtimeId: 'runtime-a' }
    })
    await settle()
  })
}

function mirroredTabIds(): string[] | undefined {
  return useAppStore.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)
}

describe('a renderer publisher returning after a headless epoch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    streams.length = 0
    runtimeCall.mockClear()
    censusGate = Promise.resolve()
    census = {
      id: 'list-all',
      ok: true,
      result: { snapshots: [] },
      _meta: { runtimeId: 'runtime-a' }
    }
    mocks.getExplicitRuntimeEnvironmentIdForWorktree.mockReset().mockReturnValue(ENV_A)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { runtimeEnvironments: { call: runtimeCall, subscribe: runtimeSubscribe } }
    })
    resetWebSessionTabsSnapshotFreshnessForTests()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only id, createdAt and pairingRevision.
    const runtimeEnvironments = [
      { id: ENV_A, createdAt: 100, pairingRevision: 101 }
    ] as PublicKnownRuntimeEnvironment[]
    replaceRuntimeEnvironmentRevisions(runtimeEnvironments)
    useAppStore.setState(
      {
        ...initialState,
        activeWorktreeId: WORKTREE,
        workspaceSessionReady: true,
        runtimeEnvironments,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mirror reads only runtimeId and connectionGeneration.
        runtimeStatusByEnvironmentId: new Map([
          [ENV_A, { status: { runtimeId: 'runtime-a' }, connectionGeneration: 1 }]
        ]) as AppState['runtimeStatusByEnvironmentId']
      },
      true
    )
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
    replaceRuntimeEnvironmentRevisions([])
    resetWebSessionTabsSnapshotFreshnessForTests()
    vi.useRealTimers()
  })

  it('mirrors the returning publisher after one authoritative census and still fences the headless one', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish({ ...frame(RENDERER_EPOCH, 3, [terminal('a')]), type: 'snapshot' })
    await publish({ ...frame(HEADLESS_EPOCH, 1, [terminal('a')]), type: 'snapshot' })
    const returning = frame(RENDERER_EPOCH, 5, [terminal('a'), terminal('b')])
    census = {
      id: 'list-all',
      ok: true,
      result: { snapshots: [returning], authoritative: true },
      _meta: { runtimeId: 'runtime-a' }
    }
    await publish({ ...returning, type: 'snapshot' })
    expect(mirroredTabIds()).not.toContain(toWebTerminalSurfaceTabId('host-tab-b'))

    await act(async () => {
      vi.advanceTimersByTime(300)
      await settle()
    })

    expect(runtimeCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: ENV_A, method: 'session.tabs.listAll' })
    )
    expect(mirroredTabIds()).toContain(toWebTerminalSurfaceTabId('host-tab-b'))

    // A delayed frame from the headless writer is now the retired one.
    await publish({ ...frame(HEADLESS_EPOCH, 2, [terminal('a')]), type: 'snapshot' })
    expect(mirroredTabIds()).toContain(toWebTerminalSurfaceTabId('host-tab-b'))
  })

  it('revives nothing from an older host whose census is not labelled authoritative', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish({ ...frame(RENDERER_EPOCH, 3, [terminal('a')]), type: 'snapshot' })
    await publish({ ...frame(HEADLESS_EPOCH, 1, [terminal('a')]), type: 'snapshot' })
    const returning = frame(RENDERER_EPOCH, 5, [terminal('a'), terminal('b')])
    census = {
      id: 'list-all',
      ok: true,
      result: { snapshots: [returning] },
      _meta: { runtimeId: 'runtime-a' }
    }
    await publish({ ...returning, type: 'snapshot' })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await settle()
    })

    expect(mirroredTabIds()).not.toContain(toWebTerminalSurfaceTabId('host-tab-b'))
  })

  it('does not let a census outrank a stream frame that arrived while it was in flight', async () => {
    renderHook(() => useWebSessionTabsSync())
    await act(settle)

    await publish({ ...frame(RENDERER_EPOCH, 3, [terminal('a')]), type: 'snapshot' })
    await publish({ ...frame(HEADLESS_EPOCH, 1, [terminal('a')]), type: 'snapshot' })
    const returning = frame(RENDERER_EPOCH, 5, [terminal('a'), terminal('b')])
    census = {
      id: 'list-all',
      ok: true,
      result: { snapshots: [returning], authoritative: true },
      _meta: { runtimeId: 'runtime-a' }
    }
    let openGate = (): void => {}
    censusGate = new Promise((resolve) => {
      openGate = resolve
    })
    await publish({ ...returning, type: 'snapshot' })
    await act(async () => {
      vi.advanceTimersByTime(300)
      await settle()
    })
    await publish({ ...frame(HEADLESS_EPOCH, 2, [terminal('a')]), type: 'snapshot' })
    await act(async () => {
      openGate()
      await settle()
    })

    expect(mirroredTabIds()).not.toContain(toWebTerminalSurfaceTabId('host-tab-b'))
  })
})
