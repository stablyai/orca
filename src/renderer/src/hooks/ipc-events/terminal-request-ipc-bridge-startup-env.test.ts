import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTabsSliceMockApi } from '../../store/slices/tabs/tabs-slice-test-harness'
import { createTestStore } from '../../store/testing/app-store-test-fixture'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
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
vi.mock('@/lib/workspace/ownership/terminal-worktree-route', () => ({
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
  presentation?: 'focused' | 'background'
  source?: 'runtime-session'
  env?: Record<string, string>
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

describe("a paired viewer's command-less terminal create", () => {
  // Main sends only spawn env for a plain remote terminal; dropping it left the pane without the
  // remote-viewer clipboard marker, so copied text never reached the viewer (#39852).
  it('queues the env as startup so the spawned pane carries it', () => {
    request({
      requestId: 'request-1',
      worktreeId: WT,
      source: 'runtime-session',
      presentation: 'focused',
      env: { ORCA_REMOTE_VIEWER_CLIPBOARD: '1', PI_CLIPBOARD_OSC52: '1' }
    })

    const tabId = replyTerminalCreate.mock.calls[0]?.[0]?.tabId
    expect(tabId).toBeDefined()
    expect(store.getState().pendingStartupByTabId[tabId!]).toEqual({
      env: { ORCA_REMOTE_VIEWER_CLIPBOARD: '1', PI_CLIPBOARD_OSC52: '1' }
    })
  })

  it('still queues nothing for a bare create without command or env', () => {
    request({ requestId: 'request-2', worktreeId: WT, presentation: 'focused' })

    const tabId = replyTerminalCreate.mock.calls[0]?.[0]?.tabId
    expect(tabId).toBeDefined()
    expect(store.getState().pendingStartupByTabId[tabId!]).toBeUndefined()
  })
})
