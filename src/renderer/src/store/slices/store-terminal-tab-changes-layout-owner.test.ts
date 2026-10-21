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
      _params: {
        command: {
          viewMode?: string
          title?: unknown
          renames?: { tabId: string; title: string | null }[]
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

/** Draws each generated title main was sent, as main's frame would (frames are not modelled). */
function mainFrameDrawsTitles(store: ReturnType<typeof createTestStore>): void {
  const titles = new Map<string, string | null>()
  for (const params of sent()) {
    for (const { tabId, title } of params.command.renames ?? []) {
      titles.set(tabId, title)
    }
  }
  const state = store.getState()
  const entityOf = new Map(
    Object.values(state.unifiedTabsByWorktree)
      .flat()
      .map((tab) => [tab.id, tab.entityId])
  )
  const drawn = new Map([...titles].map(([tabId, title]) => [entityOf.get(tabId), title]))
  store.setState({
    tabsByWorktree: Object.fromEntries(
      Object.entries(state.tabsByWorktree).map(([key, rows]) => [
        key,
        rows.map((row) =>
          drawn.has(row.id) ? { ...row, generatedTitle: drawn.get(row.id) ?? undefined } : row
        )
      ])
    )
  })
}

/** Main's answers and their handlers have run; main's frame, which draws the change, is not modelled. */
const answered = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.callRuntimeRpc.mockReset()
  mocks.toggled.mockReset()
  mocks.callRuntimeRpc.mockResolvedValue({ ok: true, result: {} })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('a terminal tab’s own changes in a layout-owner build', () => {
  it('renames in main by tab-bar id, and leaves showing the title to main’s frame', async () => {
    const { store, tabId, tabBarId } = await storeWithTab()

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
    await answered()
    expect(row(store).customTitle).toBeFalsy()
  })

  it('leaves the window’s color as it is when main refuses', async () => {
    const { store, tabId, tabBarId } = await storeWithTab()
    mocks.callRuntimeRpc.mockResolvedValue({ ok: false, code: 'invalid_params' })

    store.getState().setTabColor(tabId, '#f00')

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, color: '#f00' } }
    ])
    await vi.waitFor(() => expect(console.warn).toHaveBeenCalled())
    expect(row(store).color).toBeFalsy()
  })

  it('sends an agent’s generated title as main’s rename', async () => {
    const { store, tabId, tabBarId } = await storeWithTab()

    store
      .getState()
      .setGeneratedTabTitleFromAgentPrompt(makePaneKey(tabId, LEAF), 'Refactor the auth middleware')

    expect(sent()).toEqual([
      {
        command: {
          type: 'renameTabs',
          kind: 'generated',
          renames: [{ workspace: WORKTREE, tabId: tabBarId, title: expect.any(String) }]
        }
      }
    ])
    await answered()
    // Main's frame draws the title; the window writes none.
    expect(row(store).generatedTitle).toBeUndefined()
  })

  it('sends one agent title while main has not answered the first, as the window keeps it', async () => {
    const { store, tabId } = await storeWithTab()
    const second = makePaneKey(tabId, '22222222-2222-4222-8222-222222222222')
    const titles = () => sent().flatMap((params) => params.command.renames!.map((r) => r.title))

    store.getState().setGeneratedTabTitleFromAgentPrompt(makePaneKey(tabId, LEAF), 'fix lint')
    store.getState().setGeneratedTabTitleFromAgentPrompt(second, 'write tests')

    expect(titles()).toHaveLength(1)
    const [first] = titles()
    await answered()
    expect(row(store).generatedTitle).toBeUndefined()
    mainFrameDrawsTitles(store)
    expect(row(store).generatedTitle).toBe(first)

    store.getState().setGeneratedTabTitleFromAgentPrompt(second, 'write tests', {
      replaceExistingGeneratedTitle: true
    })
    const replaced = titles()[1]
    expect(replaced).not.toEqual(first)
    await answered()
    expect(row(store).generatedTitle).toBe(first)
  })

  it('forgets an ended launch agent in main, and sends nothing for a tab without one', async () => {
    const launched = await storeWithTab({ launchAgent: 'claude' })
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
    await answered()
    // Main's frame drops the agent; the window does not.
    expect(row(launched.store).launchAgent).toBe('claude')

    const plain = await storeWithTab()
    plain.store.getState().clearTabLaunchAgent(plain.tabId)
    plain.store.getState().setAiVaultTabTitle(plain.tabId, null)
    expect(sent()).toEqual([])
  })

  it('switches the view in main, and a toggle names the mode it switches to', async () => {
    const { store, tabBarId } = await storeWithTab()

    store.getState().toggleTabViewMode(tabBarId)

    expect(sent()).toEqual([
      { command: { type: 'setTabProps', workspace: WORKTREE, tabId: tabBarId, viewMode: 'chat' } }
    ])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledOnce())
    expect(row(store).viewMode).toBeUndefined()
  })

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

  it('toggles from the mode last set while main has not answered it', async () => {
    const { store, tabBarId } = await storeWithTab()

    store.getState().setTabViewMode(tabBarId, 'chat')
    store.getState().toggleTabViewMode(tabBarId)

    expect(sentViewModes()).toEqual(['chat', 'terminal'])
    await vi.waitFor(() => expect(mocks.toggled).toHaveBeenCalledTimes(1))
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

  it('sends an agent-title batch’s local titles to main, whose frame draws them, and shows a paired server’s tab at once', async () => {
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
    await answered()
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
        command: {
          type: 'renameTabs',
          kind: 'generated',
          renames: [{ workspace: WORKTREE, tabId: expect.any(String), title: expect.any(String) }]
        }
      }
    ])
    expect(title(remote)).toBeTruthy()
    expect(title(WORKTREE)).toBeUndefined()
    answer({ ok: true, result: {} })
    await answered()
    // Main's frame draws the local tab's title; the window writes none.
    expect(title(WORKTREE)).toBeUndefined()
    expect(sent()).toHaveLength(1)
  })

  it('sends a batch’s titles of several workspaces as one rename, and writes none itself', async () => {
    const store = createTestStore()
    const other = 'repo1::/path/other'
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), tabAutoGenerateTitle: true },
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' }),
          makeWorktree({ id: other, repoId: 'repo1', path: '/path/other' })
        ]
      }
    })
    const first = store
      .getState()
      .createTab(WORKTREE, undefined, undefined, { initialLeafId: LEAF })
    const second = store.getState().createTab(other, undefined, undefined, { initialLeafId: LEAF })
    const tabBarId = (worktreeId: string) =>
      store.getState().unifiedTabsByWorktree[worktreeId]![0]!.id
    const title = (worktreeId: string) =>
      store.getState().tabsByWorktree[worktreeId]![0]!.generatedTitle
    await answered()
    mocks.callRuntimeRpc.mockClear()
    mocks.callRuntimeRpc.mockResolvedValueOnce({
      ok: true,
      result: { untitled: [{ workspace: other, tabId: tabBarId(other), code: 'tab_not_found' }] }
    })
    const batch = [
      { paneKey: makePaneKey(first.id, LEAF), prompt: 'Refactor the auth middleware' },
      { paneKey: makePaneKey(second.id, LEAF), prompt: 'Fix the login page' }
    ]
    let publications = 0
    const unsubscribe = store.subscribe(() => {
      publications += 1
    })

    store.getState().setGeneratedTabTitlesFromAgentPrompts(batch)

    expect(sent()).toEqual([
      {
        command: {
          type: 'renameTabs',
          kind: 'generated',
          renames: [
            { workspace: WORKTREE, tabId: tabBarId(WORKTREE), title: expect.any(String) },
            { workspace: other, tabId: tabBarId(other), title: expect.any(String) }
          ]
        }
      }
    ])
    await answered()
    unsubscribe()
    // Main's frame draws the title it gave; the window writes neither.
    expect(publications).toBe(0)
    expect(title(WORKTREE)).toBeUndefined()
    expect(title(other)).toBeUndefined()
    expect(console.warn).toHaveBeenCalledWith('[layout-owner] renameTabs refused:', 'tab_not_found')
    // Settled: the refused tab's next title is sent again.
    store.getState().setGeneratedTabTitlesFromAgentPrompts([batch[1]!])
    expect(sent()).toHaveLength(2)
  })

  it('shows no title when the batch’s call fails, and sends the tab’s next title again', async () => {
    const { store, tabId } = await storeWithTab()
    mocks.callRuntimeRpc.mockRejectedValueOnce(new Error('main is gone'))
    const update = { paneKey: makePaneKey(tabId, LEAF), prompt: 'Refactor the auth middleware' }

    store.getState().setGeneratedTabTitlesFromAgentPrompts([update])

    await vi.waitFor(() =>
      expect(console.warn).toHaveBeenCalledWith(
        '[layout-owner] renameTabs refused:',
        'call_failed',
        'main is gone'
      )
    )
    expect(row(store).generatedTitle).toBeFalsy()
    store.getState().setGeneratedTabTitlesFromAgentPrompts([update])
    expect(sent()).toHaveLength(2)
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

  it('acts as today with the switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const { store, tabId } = await storeWithTab()

    store.getState().setTabCustomTitle(tabId, 'Build')

    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
    expect(row(store).customTitle).toBe('Build')
  })
})
