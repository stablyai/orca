import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { provideLayoutFrameTerminalPanes } from '@/runtime/layout-frame-terminal-panes'
import { startupNeedsWindowSpawn } from '../terminals/window-tab-start-in-main'

type HeldCreate = { resolve: (value: unknown) => void; reject: (error: Error) => void }

const mocks = vi.hoisted(() => {
  const held: { layoutOwnerIsMain: boolean; create: HeldCreate | null } = {
    layoutOwnerIsMain: true,
    create: null
  }
  return Object.assign(held, { callRuntimeRpc: vi.fn() })
})

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
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreCascadesMockApi()

const WORKTREE = 'repo1::/path/wt'
const TAB = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB}:${LEAF}`

function storeWithWorktree() {
  const store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE, repoId: 'repo1', path: '/path/wt' })] },
    groupsByWorktree: {
      [WORKTREE]: [{ id: 'group-1', worktreeId: WORKTREE, activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { [WORKTREE]: 'group-1' },
    unifiedTabsByWorktree: {}
  })
  return store
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function terminalCreateCalls() {
  return mocks.callRuntimeRpc.mock.calls.filter((call) => call[1] === 'terminal.create')
}

/** Main's frame draws the pane bound to the terminal it started. */
function drawBinding(store: ReturnType<typeof createTestStore>, ptyId: string) {
  const layout = store.getState().terminalLayoutsByTabId[TAB]!
  store.setState({
    terminalLayoutsByTabId: {
      ...store.getState().terminalLayoutsByTabId,
      [TAB]: { ...layout, ptyIdsByLeafId: { [LEAF]: ptyId } }
    }
  })
}

beforeEach(() => {
  mocks.layoutOwnerIsMain = true
  mocks.create = null
  mocks.callRuntimeRpc.mockReset()
  mocks.callRuntimeRpc.mockImplementation(async (_target: unknown, method: string) => {
    if (method === 'terminal.create') {
      return new Promise((resolve, reject) => {
        mocks.create = { resolve, reject }
      })
    }
    return { ok: true, result: { tabId: TAB } }
  })
  provideLayoutFrameTerminalPanes({ holdsTerminalPane: () => false, terminalTab: () => undefined })
})

describe("a new tab's first terminal, started by main in a layout-owner build", () => {
  it('waits, asks main to start it in the tab main wrote, then lets the pane attach', async () => {
    const store = storeWithWorktree()

    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      startupCwd: '/path/wt/src',
      pendingStartup: { command: 'make dev', env: { FOO: '1' } }
    })

    // The pane mounts waiting: it starts no terminal of its own.
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({ status: 'starting' })
    expect(mocks.callRuntimeRpc.mock.calls[0]?.[1]).toBe('layout.apply')
    await settle()
    expect(terminalCreateCalls()).toEqual([
      [
        { kind: 'local' },
        'terminal.create',
        {
          worktree: `id:${WORKTREE}`,
          windowTab: true,
          tabId: TAB,
          leafId: LEAF,
          cwd: '/path/wt/src',
          command: 'make dev',
          env: { FOO: '1' }
        }
      ]
    ])
    // Main runs the startup; a remount of the pane must not run it again.
    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()

    mocks.create!.resolve({ terminal: { ptyId: 'pty-main' } })
    await settle()
    // Until main's binding is drawn, the pane keeps waiting, so it never spawns a second one.
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({ status: 'starting' })
    drawBinding(store, 'pty-main')
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('shows why when main could not start it, as a start that timed out does', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    mocks.create!.reject(new Error('Request timed out: createOrAttach'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toEqual({
      status: 'failed',
      reason: 'Request timed out: createOrAttach'
    })
    expect(store.getState().tabsByWorktree[WORKTREE]?.map((tab) => tab.id)).toEqual([TAB])
  })

  it('lets the pane attach to whatever main binds it to', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()
    mocks.create!.resolve({ terminal: { ptyId: 'pty-main' } })
    await settle()

    // Main rebound the pane before the window drew its first terminal.
    drawBinding(store, 'pty-rebound')
    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('never runs a failed start’s startup again, which main may have run before failing', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()

    mocks.create!.reject(new Error('shell not found'))
    await settle()

    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })

  it('attaches to the terminal that won the pane instead of showing a failure', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    mocks.create!.reject(new Error('terminal_pane_owner_changed'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
  })

  it('starts its own terminal, with its startup, when main does not hold the tab', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()

    mocks.create!.reject(new Error('host_not_owned'))
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey[PANE_KEY]).toBeUndefined()
    expect(store.getState().pendingStartupByTabId[TAB]).toMatchObject({ command: 'make dev' })
  })

  it('gives no startup back to a tab the user closed before main answered', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'make dev' }
    })
    await settle()
    const { [TAB]: _closed, ...layouts } = store.getState().terminalLayoutsByTabId
    store.setState({ terminalLayoutsByTabId: layouts })

    mocks.create!.reject(new Error('host_not_owned'))
    await settle()

    expect(store.getState().pendingStartupByTabId[TAB]).toBeUndefined()
  })

  it('keeps the window spawn for a startup only it carries, and for a tab with a terminal', async () => {
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, {
      id: TAB,
      initialLeafId: LEAF,
      pendingStartup: { command: 'claude', delivery: 'terminal-paste' }
    })
    store.getState().createTab(WORKTREE, undefined, undefined, { initialPtyId: 'pty-live' })
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(terminalCreateCalls()).toEqual([])
  })

  it('sends nothing to start with the build switch off', async () => {
    mocks.layoutOwnerIsMain = false
    const store = storeWithWorktree()
    store.getState().createTab(WORKTREE, undefined, undefined, { id: TAB, initialLeafId: LEAF })
    await settle()

    expect(store.getState().terminalPaneStartsByPaneKey).toEqual({})
    expect(mocks.callRuntimeRpc).not.toHaveBeenCalled()
  })
})

describe('startupNeedsWindowSpawn', () => {
  it('sends main a plain startup, and keeps the window spawn for one only it carries', () => {
    expect(startupNeedsWindowSpawn(undefined)).toBe(false)
    expect(startupNeedsWindowSpawn({ command: 'ls', env: { A: '1' }, launchAgent: 'claude' })).toBe(
      false
    )
    for (const field of [
      { delivery: 'terminal-paste' as const },
      { agentLaunch: { agent: 'claude' } },
      { agentArgsOverride: null },
      { draftPrompt: 'hi' },
      { sessionOptions: {} },
      { initialAgentStatus: { agent: 'claude' as const, prompt: 'hi' } },
      { showSessionRestoredBanner: true },
      { telemetry: {} }
    ]) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each field is checked only for presence, never read.
      expect(startupNeedsWindowSpawn({ command: 'x', ...field } as never)).toBe(true)
    }
  })
})
