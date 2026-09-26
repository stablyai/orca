import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { subscribeRuntimeEnvironmentFromPreload } from '../../../../preload/runtime-environment-subscriptions'
import { tagRuntimeSubscriptionReplayResponse } from '../../../../shared/runtime-subscription-replay'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import { registerRuntimeClientIpcBridge } from './runtime-client-ipc-bridge'

const initialState = useAppStore.getState()

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function createHarness() {
  type Ipc = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[0]
  type Args = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[1]
  type Callbacks = Parameters<typeof subscribeRuntimeEnvironmentFromPreload>[2]
  let listener: Parameters<Ipc['on']>[1] | undefined
  const pending: ReturnType<typeof Promise.withResolvers<unknown>>[] = []
  const issueRead = Promise.withResolvers<null>()
  const ipc: Ipc = {
    invoke: vi.fn((channel) => {
      if (channel !== 'runtimeEnvironments:subscribe') {
        return Promise.resolve()
      }
      const setup = Promise.withResolvers<unknown>()
      pending.push(setup)
      return setup.promise
    }),
    send: vi.fn(),
    on: (_channel, callback) => {
      listener = callback
    },
    removeListener: vi.fn()
  }
  const getIssue = vi.fn(() => issueRead.promise)
  const refreshStatus = vi.fn(async () => true)
  let nextId = 0
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: {
        subscribe: (args: Args, callbacks: Callbacks) =>
          subscribeRuntimeEnvironmentFromPreload(ipc, args, callbacks, () => `sub-${nextId++}`),
        call: vi.fn(async () => ({ id: 'r', ok: true, result: [] }))
      },
      linear: { getIssue }
    }
  })
  const status = createCompatibleRuntimeStatusResponse()
  if (!status.ok) {
    throw new Error('expected valid runtime status fixture')
  }
  useAppStore.setState({
    settings: null,
    runtimeEnvironments: [
      {
        id: 'host-a',
        name: 'Host A',
        createdAt: 1,
        updatedAt: 1,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [
          { id: 'ws-a', kind: 'websocket', label: 'WS', endpoint: 'ws://example.invalid' }
        ],
        preferredEndpointId: 'ws-a'
      }
    ],
    runtimeStatusByEnvironmentId: new Map([['host-a', { status: status.result, checkedAt: 1 }]]),
    linearIssueCache: {},
    linearSearchCache: {},
    linearListCache: {},
    linearProjectIssueCache: {},
    linearCustomViewIssueCache: {},
    checkLinearConnection: vi.fn(async () => {}),
    refreshRuntimeEnvironmentStatus: refreshStatus
  })
  const starts: (() => void)[] = []
  const start = (): (() => void) => {
    const unsubs: (() => void)[] = []
    const unsubscribeStore = registerRuntimeClientIpcBridge(unsubs, {
      worktreeChangeRefreshQueue: { enqueue: vi.fn(), dispose: vi.fn() },
      activateNotifiedWorktree: vi.fn(async () => {})
    })
    const stop = (): void => {
      unsubscribeStore()
      unsubs.forEach((unsubscribe) => unsubscribe())
    }
    starts.push(stop)
    return stop
  }
  return {
    start,
    getIssue,
    refreshStatus,
    pending,
    ipc,
    emit: (index: number, replay = false) => {
      const response = {
        id: 'r',
        ok: true as const,
        _meta: { runtimeId: 'remote-runtime' },
        result: {
          type: 'linearLinkedIssueUpdated',
          identifier: 'ISSUE-1',
          workspaceId: 'workspace-a'
        }
      }
      listener?.(null, {
        subscriptionId: `sub-${index}`,
        type: 'response',
        response: replay ? tagRuntimeSubscriptionReplayResponse(response) : response
      })
    },
    finish: async () => {
      starts.forEach((stop) => stop())
      pending.forEach((setup, index) =>
        setup.resolve({ subscriptionId: `sub-${index}`, requestId: 'r' })
      )
      issueRead.resolve(null)
      for (let index = 0; index < 30; index += 1) {
        await Promise.resolve()
      }
    }
  }
}

it('does no Linear read dispatch or cache publication after cleanup while setup is pending', async () => {
  const h = createHarness()
  let publications = 0
  const stopCounting = useAppStore.subscribe((state, previous) => {
    if (state.linearIssueCache !== previous.linearIssueCache) {
      publications += 1
    }
  })
  try {
    h.start()()
    for (let index = 0; index < 100; index += 1) {
      h.emit(0)
    }
    expect(h.getIssue).not.toHaveBeenCalled()
    expect(publications).toBe(0)
  } finally {
    stopCounting()
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})

it('does no replay recovery or resubscription after cleanup', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.emit(0, true)
    expect(h.refreshStatus).not.toHaveBeenCalled()
    expect(h.pending).toHaveLength(1)
    expect(h.getIssue).not.toHaveBeenCalled()
  } finally {
    await h.finish()
  }
})

it('accepts a fresh bridge early frame while rejecting the previous bridge frame', async () => {
  const h = createHarness()
  try {
    h.start()()
    h.start()
    h.emit(0)
    h.emit(1)
    expect(h.getIssue).toHaveBeenCalledOnce()
    expect(h.getIssue).toHaveBeenCalledWith({ id: 'ISSUE-1', workspaceId: 'workspace-a' })
  } finally {
    await h.finish()
  }
  expect(h.ipc.removeListener).toHaveBeenCalledOnce()
})
