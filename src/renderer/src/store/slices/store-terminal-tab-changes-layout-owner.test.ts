import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type * as ResolveOwnerModule from '@/lib/resolve-owner'
import { getDefaultSettings } from '../../../../shared/constants'
import '../../../../shared/stable-pane-id'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

type Reply = { ok: boolean; result?: object; code?: string }

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  twin: false,
  toggled: vi.fn(),
  callRuntimeRpc: vi.fn(
    async (
      _target: unknown,
      _method: string,
      _params: {
        command: {
          viewMode?: string
          title?: unknown
        }
      }
    ): Promise<Reply> => ({ ok: true, result: {} })
  )
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
vi.mock('@/lib/resolve-owner', async (importOriginal) => {
  const actual = await importOriginal<typeof ResolveOwnerModule>()
  return {
    ...actual,
    runtimeEnvironmentIdForWorkspaceOwner: (
      ...args: Parameters<typeof actual.runtimeEnvironmentIdForWorkspaceOwner>
    ) =>
      mocks.twin
        ? { kind: 'ambiguous' as const }
        : actual.runtimeEnvironmentIdForWorkspaceOwner(...args)
  }
})
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))
vi.mock('@/lib/native-chat-telemetry', () => ({ emitNativeChatToggled: mocks.toggled }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/wt'
const LEAF = '11111111-1111-4111-8111-111111111111'

async function storeWithTab(options: { launchAgent?: 'claude' } = {}) {
  const store = createTestStore()
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] }
  })
  const tab = store.getState().createTab(WORKTREE, undefined, undefined, {
    initialLeafId: LEAF,
    ...options
  })
  const tabBarId = store.getState().unifiedTabsByWorktree[WORKTREE]![0]!.id
  // Why: main's terminal.create follows the create's layout.apply reply; settle both first.
  await answered()
  mocks.callRuntimeRpc.mockClear()
  return { store, tabId: tab.id, tabBarId }
}

/** The layout commands sent after the tab's create. */
const sent = () => mocks.callRuntimeRpc.mock.calls.map((call) => call[2])

const sentViewModes = () => sent().map((params) => params.command.viewMode)

const row = (store: ReturnType<typeof createTestStore>) =>
  store.getState().tabsByWorktree[WORKTREE]![0]!

/** Main's answers and their handlers have run; main's frame, which draws the change, is not modelled. */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.twin = false
  mocks.callRuntimeRpc.mockReset()
  mocks.toggled.mockReset()
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a terminal tab’s own changes in a layout-owner build', () => {
  it('flips a second toggle sent before main answers the first, as the window would', async () => {
    const { store, tabBarId } = await storeWithTab()

    store.getState().toggleTabViewMode(tabBarId)
    store.getState().toggleTabViewMode(tabBarId)

    expect(sentViewModes()).toEqual(['chat', 'terminal'])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledTimes(2))
    expect(mocks.toggled.mock.calls.map(([event]) => [event.from, event.to])).toEqual([
      ['terminal', 'chat'],
      ['chat', 'terminal']
    ])
    expect(row(store).viewMode).toBeUndefined()
  })

  it('toggles from the shown mode again once main refuses the pending one', async () => {
    const { store, tabBarId } = await storeWithTab()
    mocks.callRuntimeRpc.mockResolvedValueOnce({ ok: false, code: 'invalid_params' })

    store.getState().toggleTabViewMode(tabBarId)
    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[layout-owner] setTabProps refused:',
        'invalid_params'
      )
    )
    store.getState().toggleTabViewMode(tabBarId)

    expect(sentViewModes()).toEqual(['chat', 'chat'])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledTimes(1))
    expect(row(store).viewMode).toBeUndefined()
  })
})
