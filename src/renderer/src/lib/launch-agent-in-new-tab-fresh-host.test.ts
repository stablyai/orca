// Real-store coverage: which plain new-tab launches start through the host's agent.launch.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))
vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))
const callRuntimeRpc = vi.hoisted(() =>
  vi.fn<(target: unknown, method: string, params: Record<string, unknown>) => Promise<unknown>>()
)
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc
}))

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

type Settings = Partial<ReturnType<typeof getDefaultSettings>>

function seed(settings: Settings = {}) {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), ...settings },
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  return store
}

function launchCalls() {
  return callRuntimeRpc.mock.calls.filter(([, method]) => method === 'agent.launchReplay')
}

beforeEach(() => {
  vi.clearAllMocks()
  callRuntimeRpc.mockReturnValue(new Promise(() => {}))
})

describe('a plain new-tab launch', () => {
  it('starts through the host with no prompt and queues no startup command of its own', async () => {
    const store = seed()
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      requestId: 'request-1',
      agent: 'claude',
      worktreeId: WT,
      freshNewTab: true
    })

    const tabId = result?.surface.kind === 'local-terminal' ? result.surface.tabId : ''
    expect(launchCalls()).toHaveLength(1)
    expect(launchCalls()[0]?.[2]).toMatchObject({
      agent: 'claude',
      target: { kind: 'existing', worktree: `id:${WT}` },
      launchSource: 'tab_bar_quick_launch',
      presentation: 'focused'
    })
    expect(launchCalls()[0]?.[2]).not.toHaveProperty('prompt')
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(store.getState().activeTabId).toBe(tabId)
  })

  const kept: [string, { prompt?: string; freshNewTab?: true }, Settings][] = [
    ['a prompt', { prompt: 'fix it' }, {}],
    ['no opt-in', { freshNewTab: undefined }, {}],
    ['a disabled agent', {}, { disabledTuiAgents: ['claude'] }],
    ['the chat default on', {}, { experimentalNativeChat: true }]
  ]
  it.each(kept)('keeps main launch with %s', async (_label, extra, settings) => {
    const store = seed(settings)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      requestId: 'request-2',
      agent: 'claude',
      worktreeId: WT,
      freshNewTab: true,
      ...extra
    })

    expect(launchCalls()).toHaveLength(0)
    if (!('experimentalNativeChat' in settings)) {
      expect(Object.keys(store.getState().pendingStartupByTabId)).toHaveLength(1)
    }
  })
})
