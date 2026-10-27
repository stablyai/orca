import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { RuntimeTerminalCreate } from '../../../../shared/runtime-terminal-contracts'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  seedStore
} from '../../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../../store/slices/store-cascades-test-harness'
import { createTerminalTabOnHost } from './tab-bar-host-terminal-create'

type HostCreateMocks = {
  callRuntimeRpc: ReturnType<typeof vi.fn>
  store: null | ReturnType<typeof createTestStore>
}

const mocks = vi.hoisted((): HostCreateMocks => ({ callRuntimeRpc: vi.fn(), store: null }))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})
vi.mock('../../store', () => ({
  get useAppStore() {
    return mocks.store
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/focus-terminal-tab-surface', () => ({ focusTerminalTabSurface: vi.fn() }))

const mockApi = createStoreCascadesMockApi()
// The preload bridge that commits a membership-only close in main.
const closeTerminalSurface = vi.fn(async () => {})
Object.assign(mockApi, { session: { closeTerminalSurface } })

const WT = 'repo1::/path/wt1'
const HOST = 'runtime:env-1'
const REQUEST = {
  worktreeId: WT,
  groupId: 'group-1',
  executionHostId: HOST,
  projectHostSetupId: 'env-setup'
} as const

function seed(worktrees = [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })]) {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: worktrees },
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    unifiedTabsByWorktree: {}
  })
  mocks.store = store
  return store
}

const tabsIn = (store: ReturnType<typeof createTestStore>) =>
  store.getState().unifiedTabsByWorktree[WT] ?? []
beforeEach(() => {
  mocks.callRuntimeRpc.mockReset()
  closeTerminalSurface.mockClear()
})

/** The tab id this create asked local main to admit. */
const requestedTabId = () =>
  mocks.callRuntimeRpc.mock.calls.find(([, method]) => method === 'terminal.create')?.[2]?.tabId

describe('createTerminalTabOnHost', () => {
  it('refuses a foreign source before creating a terminal or tab', async () => {
    const store = seed([makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1' }, 'env-1')])
    expect(await createTerminalTabOnHost(REQUEST)).toMatchObject({
      status: 'refused',
      refusal: { code: 'source_worktree_not_local' }
    })
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(tabsIn(store)).toEqual([])
  })

  it.each(['created', 'adopted'] as const)(
    'cleans a stale source once for a %s terminal',
    async (disposition) => {
      const store = seed()
      const closeTab = vi.spyOn(store.getState(), 'closeTab')
      let answer: (value: { terminal: RuntimeTerminalCreate }) => void = () => {}
      const response = new Promise<{ terminal: RuntimeTerminalCreate }>((resolve) => {
        answer = resolve
      })
      mocks.callRuntimeRpc.mockImplementation((_target: unknown, method: string) =>
        method === 'terminal.create' ? response : Promise.resolve({})
      )
      const pending = createTerminalTabOnHost(REQUEST)
      store.setState({
        worktreesByRepo: { repo1: [makeRuntimeOwnedWorktree({ id: WT, repoId: 'repo1' }, 'env-1')] }
      })
      answer({
        terminal: {
          handle: 'term-9',
          worktreeId: 'remote-wt',
          title: null,
          executionHostId: HOST,
          ptyId: 'remote:env-1@@term-9',
          agentSessionDisposition: disposition
        }
      })
      expect(await pending).toMatchObject({
        status: 'refused',
        refusal: { code: 'source_worktree_not_local' }
      })
      if (disposition === 'created') {
        expect(closeTab).toHaveBeenCalledExactlyOnceWith(requestedTabId(), {
          reason: 'cleanup',
          captureRecentlyClosed: false
        })
      } else {
        expect(closeTab).not.toHaveBeenCalled()
      }
      expect(closeTerminalSurface).toHaveBeenCalledExactlyOnceWith({
        worktreeId: WT,
        target: { kind: 'tab', tabId: requestedTabId() },
        reason: 'cleanup'
      })
      expect(tabsIn(store)).toEqual([])
    }
  )
})
