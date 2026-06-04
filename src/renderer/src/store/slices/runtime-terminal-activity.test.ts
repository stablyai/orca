import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeTerminalSummary } from '../../../../shared/runtime-types'
import {
  MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION,
  RUNTIME_PROTOCOL_VERSION
} from '../../../../shared/protocol-version'
import { createTestStore } from './store-test-helpers'
import { buildRuntimeTerminalActivityByWorktreeId } from './runtime-terminal-activity'

function makeTerminal(
  overrides: Partial<RuntimeTerminalSummary> & Pick<RuntimeTerminalSummary, 'worktreeId'>
): RuntimeTerminalSummary {
  const { worktreeId, ...rest } = overrides
  return {
    handle: 'terminal-handle',
    worktreeId,
    worktreePath: '/tmp/worktree',
    branch: 'feature',
    tabId: 'tab-1',
    leafId: 'leaf-1',
    title: null,
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: '',
    ...rest
  }
}

function makeTerminalListResponse(terminals: RuntimeTerminalSummary[]) {
  return {
    ok: true,
    result: {
      terminals,
      totalCount: terminals.length,
      truncated: false
    }
  }
}

function makeRuntimeStatusResponse() {
  return {
    ok: true,
    result: {
      runtimeId: 'runtime-1',
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: null,
      liveTabCount: 0,
      liveLeafCount: 0,
      runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
      minCompatibleRuntimeClientVersion: MIN_COMPATIBLE_RUNTIME_CLIENT_VERSION
    }
  }
}

function createDeferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve
  })
  return { promise, resolve }
}

describe('runtime terminal activity slice', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('indexes only connected runtime terminals by worktree', () => {
    expect(
      buildRuntimeTerminalActivityByWorktreeId([
        makeTerminal({ worktreeId: 'wt-1', connected: true }),
        makeTerminal({ worktreeId: 'wt-2', connected: false }),
        makeTerminal({ worktreeId: '   ', connected: true })
      ])
    ).toEqual({ 'wt-1': true })
  })

  it('refreshes local runtime terminal activity and bumps sort epoch on changes', async () => {
    const runtimeCall = vi.fn(async () => ({
      ok: true,
      result: {
        terminals: [
          makeTerminal({ worktreeId: 'wt-1', connected: true }),
          makeTerminal({ worktreeId: 'wt-2', connected: false })
        ],
        totalCount: 2,
        truncated: false
      }
    }))
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: runtimeCall
        }
      }
    })
    const store = createTestStore()
    const initialSortEpoch = store.getState().sortEpoch

    await store.getState().refreshRuntimeTerminalActivity()

    expect(runtimeCall).toHaveBeenCalledWith({
      method: 'terminal.list',
      params: expect.objectContaining({ limit: 1000 })
    })
    expect(store.getState().runtimeTerminalActivityByWorktreeId).toEqual({ 'wt-1': true })
    expect(store.getState().runtimeTerminalActivityTargetKey).toBe('local')
    expect(store.getState().runtimeTerminalActivityError).toBeNull()
    expect(store.getState().sortEpoch).toBe(initialSortEpoch + 1)
  })

  it('ignores a terminal list response that resolves after activity is cleared', async () => {
    const localList = createDeferred<ReturnType<typeof makeTerminalListResponse>>()
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: vi.fn(() => localList.promise)
        }
      }
    })
    const store = createTestStore()

    const refresh = store.getState().refreshRuntimeTerminalActivity()
    store.getState().clearRuntimeTerminalActivity()
    localList.resolve(makeTerminalListResponse([makeTerminal({ worktreeId: 'wt-stale' })]))
    await refresh

    expect(store.getState().runtimeTerminalActivityByWorktreeId).toEqual({})
    expect(store.getState().runtimeTerminalActivityTargetKey).toBeNull()
    expect(store.getState().runtimeTerminalActivityError).toBeNull()
  })

  it('starts a fresh refresh and ignores stale results when the runtime target changes', async () => {
    const localList = createDeferred<ReturnType<typeof makeTerminalListResponse>>()
    const runtimeCall = vi.fn(() => localList.promise)
    const runtimeEnvironmentCall = vi.fn(async ({ method }: { method: string }) => {
      if (method === 'status.get') {
        return makeRuntimeStatusResponse()
      }
      if (method === 'terminal.list') {
        return makeTerminalListResponse([makeTerminal({ worktreeId: 'wt-env' })])
      }
      throw new Error(`Unexpected method ${method}`)
    })
    vi.stubGlobal('window', {
      api: {
        runtime: {
          call: runtimeCall
        },
        runtimeEnvironments: {
          call: runtimeEnvironmentCall
        }
      }
    })
    const store = createTestStore()

    const localRefresh = store.getState().refreshRuntimeTerminalActivity()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-runtime-activity' } as never })
    const environmentRefresh = store.getState().refreshRuntimeTerminalActivity()
    localList.resolve(makeTerminalListResponse([makeTerminal({ worktreeId: 'wt-local' })]))
    await Promise.all([localRefresh, environmentRefresh])

    expect(runtimeCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({ selector: 'env-runtime-activity', method: 'terminal.list' })
    )
    expect(store.getState().runtimeTerminalActivityByWorktreeId).toEqual({ 'wt-env': true })
    expect(store.getState().runtimeTerminalActivityTargetKey).toBe(
      'environment:env-runtime-activity'
    )
    expect(store.getState().runtimeTerminalActivityError).toBeNull()
  })
})
