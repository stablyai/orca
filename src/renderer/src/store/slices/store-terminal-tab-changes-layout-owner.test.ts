import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { getDefaultSettings } from '../../../../shared/constants'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeWorktree,
  runtimeOwnedRepoState,
  seedStore
} from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'

type Reply = { ok: boolean; result?: object; code?: string }

const mocks = vi.hoisted(() => ({
  layoutOwnerIsMain: true,
  toggled: vi.fn(),
  callRuntimeRpc: vi.fn(
    async (
      _target: unknown,
      _method: string,
      _params: { command: { viewMode?: string; title?: unknown } }
    ): Promise<Reply> => ({ ok: true, result: {} })
  )
}))

vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return mocks.layoutOwnerIsMain
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.callRuntimeRpc }))
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

function storeWithTab(options: { launchAgent?: 'claude' } = {}) {
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
  mocks.callRuntimeRpc.mockClear()
  return { store, tabId: tab.id, tabBarId }
}

/** The layout commands sent after the tab's create. */
const sent = () => mocks.callRuntimeRpc.mock.calls.map((call) => call[2])

const sentViewModes = () => sent().map((params) => params.command.viewMode)

const row = (store: ReturnType<typeof createTestStore>) =>
  store.getState().tabsByWorktree[WORKTREE]![0]!

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockReset()
  mocks.toggled.mockReset()
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a terminal tab’s own changes in a layout-owner build', () => {
  it('renames in main first by tab-bar id, then the window shows the title', async () => {
    const { store, tabId, tabBarId } = storeWithTab()

    store.getState().setTabCustomTitle(tabId, 'Build')

    expect(sent()).toEqual([
      {
        command: {
          type: 'renameTab',
          workspace: WORKTREE,
          tabId: tabBarId,
          kind: 'custom',
          title: 'Build'
        }
      }
    ])
    expect(row(store).customTitle).toBeFalsy()
    await vi.waitFor(() => expect(row(store).customTitle).toBe('Build'))
  })

  it('leaves the window’s color as it is when main refuses', async () => {
    const { store, tabId, tabBarId } = storeWithTab()
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'invalid_params' })

    store.getState().setTabColor(tabId, '#f00')

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, color: '#f00' } }
    ])
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(row(store).color).toBeFalsy()
  })

  it('sends an agent’s generated title as main’s rename', async () => {
    const { store, tabId, tabBarId } = storeWithTab()

    store
      .getState()
      .setGeneratedTabTitleFromAgentPrompt(makePaneKey(tabId, LEAF), 'Refactor the auth middleware')

    expect(sent()).toEqual([
      {
        command: expect.objectContaining({
          type: 'renameTab',
          tabId: tabBarId,
          kind: 'generated',
          title: expect.any(String)
        })
      }
    ])
    await vi.waitFor(() => expect(row(store).generatedTitle).toBeTruthy())
  })

  it('sends one agent title while main has not answered the first, as the window keeps it', async () => {
    const { store, tabId } = storeWithTab()
    const second = makePaneKey(tabId, '22222222-2222-4222-8222-222222222222')
    const titles = () => sent().map((params) => params.command.title)

    store.getState().setGeneratedTabTitleFromAgentPrompt(makePaneKey(tabId, LEAF), 'fix lint')
    store.getState().setGeneratedTabTitleFromAgentPrompt(second, 'write tests')

    expect(titles()).toHaveLength(1)
    const [first] = titles()
    await vi.waitFor(() => expect(row(store).generatedTitle).toBe(first))

    store.getState().setGeneratedTabTitleFromAgentPrompt(second, 'write tests', {
      replaceExistingGeneratedTitle: true
    })
    const replaced = titles()[1]
    expect(replaced).not.toEqual(first)
    await vi.waitFor(() => expect(row(store).generatedTitle).toBe(replaced))
  })

  it('forgets an ended launch agent in main, and sends nothing for a tab without one', async () => {
    const launched = storeWithTab({ launchAgent: 'claude' })
    launched.store.getState().clearTabLaunchAgent(launched.tabId)

    expect(sent()).toEqual([
      {
        command: {
          type: 'setTabProps',
          workspace: WORKTREE,
          tabId: launched.tabBarId,
          clearLaunchAgent: true
        }
      }
    ])
    await vi.waitFor(() => expect(row(launched.store).launchAgent).toBeUndefined())

    const plain = storeWithTab()
    plain.store.getState().clearTabLaunchAgent(plain.tabId)
    plain.store.getState().setAiVaultTabTitle(plain.tabId, null)
    expect(sent()).toEqual([])
  })

  it('switches the view in main first, and a toggle names the mode it switches to', async () => {
    const { store, tabBarId } = storeWithTab()

    store.getState().toggleTabViewMode(tabBarId)

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, viewMode: 'chat' } }
    ])
    expect(row(store).viewMode).toBeUndefined()
    await vi.waitFor(() => expect(row(store).viewMode).toBe('chat'))
  })

  it('flips a second toggle sent before main answers the first, as the window would', async () => {
    const { store, tabBarId } = storeWithTab()

    store.getState().toggleTabViewMode(tabBarId)
    store.getState().toggleTabViewMode(tabBarId)

    expect(sentViewModes()).toEqual(['chat', 'terminal'])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledTimes(2))
    expect(mocks.toggled.mock.calls.map(([event]) => [event.from, event.to])).toEqual([
      ['terminal', 'chat'],
      ['chat', 'terminal']
    ])
    expect(row(store).viewMode).toBe('terminal')
  })

  it('toggles from the mode last set while main has not answered it', async () => {
    const { store, tabBarId } = storeWithTab()

    store.getState().setTabViewMode(tabBarId, 'chat')
    store.getState().toggleTabViewMode(tabBarId)

    expect(sentViewModes()).toEqual(['chat', 'terminal'])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledTimes(1))
    expect(row(store).viewMode).toBe('terminal')
  })

  it('toggles from the shown mode again once main refuses the pending one', async () => {
    const { store, tabBarId } = storeWithTab()
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
    await vi.waitFor(() => expect(row(store).viewMode).toBe('chat'))
    expect(mocks.toggled).toHaveBeenCalledTimes(1)
  })

  it('gives each tab of an agent-title batch its title once main has it, and a paired server’s tab at once', async () => {
    const store = createTestStore()
    const remote = 'repo2::/path/remote'
    seedStore(
      store,
      runtimeOwnedRepoState('env-1', 'repo2', '/path/remote', {
        settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
        worktreesByRepo: {
          repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })],
          repo2: [makeRuntimeOwnedWorktree({ id: remote, repoId: 'repo2' }, 'env-1')]
        }
      })
    )
    const local = store
      .getState()
      .createTab(WORKTREE, undefined, undefined, { initialLeafId: LEAF })
    const paired = store.getState().createTab(remote, undefined, undefined, { initialLeafId: LEAF })
    mocks.callRuntimeRpc.mockClear()
    let answer: (reply: { ok: boolean; result: object }) => void = () => {}
    mocks.callRuntimeRpc.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)))
    const title = (worktreeId: string) =>
      store.getState().tabsByWorktree[worktreeId]![0]!.generatedTitle

    store.getState().setGeneratedTabTitlesFromAgentPrompts([
      { paneKey: makePaneKey(local.id, LEAF), prompt: 'Refactor the auth middleware' },
      { paneKey: makePaneKey(paired.id, LEAF), prompt: 'Fix the login page' }
    ])

    expect(sent()).toEqual([
      {
        command: expect.objectContaining({
          type: 'renameTab',
          kind: 'generated',
          workspace: WORKTREE
        })
      }
    ])
    expect(title(remote)).toBeTruthy()
    expect(title(WORKTREE)).toBeUndefined()
    answer({ ok: true, result: {} })
    await vi.waitFor(() => expect(title(WORKTREE)).toBeTruthy())
    expect(sent()).toHaveLength(1)
  })

  it('acts as today at once for a paired server’s workspace', () => {
    const store = createTestStore()
    const worktree = makeRuntimeOwnedWorktree({ id: WORKTREE, repoId: 'repo1' }, 'env-1')
    seedStore(
      store,
      runtimeOwnedRepoState('env-1', 'repo1', '/path', { worktreesByRepo: { repo1: [worktree] } })
    )
    const tab = store.getState().createTab(WORKTREE)

    store.getState().setTabCustomTitle(tab.id, 'Build')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(row(store).customTitle).toBe('Build')
  })

  it('acts as today with the switch off', () => {
    mocks.layoutOwnerIsMain = false
    const { store, tabId } = storeWithTab()

    store.getState().setTabCustomTitle(tabId, 'Build')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(row(store).customTitle).toBe('Build')
  })
})
