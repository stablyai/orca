import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from '../../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))
const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('../../store', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
vi.mock('@/lib/terminal-worktree-route', () => ({
  resolveTerminalWorktreeRoute: () => ({ runtimeEnvironmentId: null })
}))
vi.mock('./terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusTerminalInitiatedTab: vi.fn()
}))

createTabsSliceMockApi()

const { registerTerminalRequestIpcBridge } = await import('./terminal-request-ipc-bridge')

const WT = 'repo1::/tmp/feature'

type CreateRequest = {
  requestId: string
  worktreeId: string
  targetGroupId?: string
  presentation?: 'focused' | 'background'
}

let request!: (data: CreateRequest) => void
const replyTerminalCreate = vi.fn()
let store: ReturnType<typeof createTestStore>

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  replyTerminalCreate.mockClear()
  vi.stubGlobal('window', {
    ...globalThis.window,
    api: {
      ...globalThis.window?.api,
      ui: {
        ...globalThis.window?.api?.ui,
        onRequestTerminalCreate: (callback: (data: CreateRequest) => void) => {
          request = callback
          return () => {}
        },
        replyTerminalCreate
      }
    }
  })
  registerTerminalRequestIpcBridge([])
  store.getState().setActiveWorktree(WT)
})

describe("a host's focused terminal create into a requested group", () => {
  // Activating a workspace with a live tab prunes its empty groups; the requested one must survive.
  it('lands in a just-created empty split beside a live terminal', () => {
    store.getState().createTab(WT)
    const sourceGroupId = store.getState().groupsByWorktree[WT]![0]!.id
    const splitGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')!
    store.getState().focusGroup(WT, splitGroupId)

    request({
      requestId: 'request-1',
      worktreeId: WT,
      targetGroupId: splitGroupId,
      presentation: 'focused'
    })

    const tabId = replyTerminalCreate.mock.calls[0]?.[0]?.tabId
    expect(tabId).toBeDefined()
    const landed = store
      .getState()
      .unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === tabId)?.groupId
    expect(landed).toBe(splitGroupId)
    expect(store.getState().groupsByWorktree[WT]?.map((group) => group.id)).toContain(splitGroupId)
  })

  it('is new work in a workspace with no live terminal: its first bind moves it up in Recent', () => {
    store.getState().setActiveWorktree('repo1::/tmp/other')

    request({ requestId: 'request-2', worktreeId: WT, presentation: 'focused' })

    const tabId: string = replyTerminalCreate.mock.calls[0]?.[0]?.tabId
    const tab = store.getState().tabsByWorktree[WT]?.find((candidate) => candidate.id === tabId)
    expect(tab?.pendingActivationSpawn).toBeUndefined()
    const epoch = store.getState().sortEpoch
    store.getState().updateTabPtyId(tabId, 'pty-new-1')
    expect(store.getState().sortEpoch).toBe(epoch + 1)
  })
})
