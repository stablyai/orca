import { beforeEach, expect, it, vi } from 'vitest'
import {
  createTestStore,
  makeRuntimeOwnedWorktree,
  makeTab,
  makeWorktree,
  seedStore
} from '@/store/slices/store-test-helpers'
import {
  clearWorktreeSleepIntent,
  forgetWorktreeSleepIntent,
  hasWorktreeSleepIntent
} from '@/lib/worktree-sleep-intent'

const mocks = vi.hoisted(() => ({
  chat: vi.fn(),
  terminal: vi.fn(),
  suspend: vi.fn(),
  toast: vi.fn()
}))
let store: ReturnType<typeof createTestStore>
vi.mock('@/store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.chat
}))
vi.mock('@/runtime/remote-worktree-sleep', () => ({ requestRemoteWorktreeSleep: mocks.terminal }))
vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  unregisterPtyDataHandlers: () => [],
  restorePtyDataHandlersAfterFailedShutdown: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
import { runSleepWorktrees } from './sleep-worktree-flow'

const ids = ['repo1::/one', 'repo1::/two']
beforeEach(() => {
  vi.clearAllMocks()
  ids.forEach(forgetWorktreeSleepIntent)
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: {
      repo1: ids.map((id) =>
        makeRuntimeOwnedWorktree({ id, repoId: 'repo1', hostId: 'runtime:env-a' }, 'env-a')
      )
    },
    tabsByWorktree: Object.fromEntries(ids.map((id) => [id, [makeTab({ id, worktreeId: id })]])),
    ptyIdsByTabId: Object.fromEntries(ids.map((id) => [id, [`remote:env-a@@${id}`]]))
  })
  mocks.chat.mockResolvedValue({ stoppedSessionIds: ['chat'] })
  mocks.terminal.mockResolvedValue(undefined)
  mocks.suspend.mockResolvedValue(null)
  vi.stubGlobal('window', {
    api: { ephemeralVm: { suspendWorkspace: mocks.suspend }, pty: { kill: vi.fn() } }
  })
})

it('admits both real terminal actions and chat stops before a held first terminal, then honors wake', async () => {
  const browser = store.getState().shutdownWorktreeBrowsers
  store.setState({
    shutdownWorktreeBrowsers: (id) => {
      browser(id)
      if (id === ids[1]) {
        store.setState({
          ptyIdsByTabId: {
            ...store.getState().ptyIdsByTabId,
            [id]: [`remote:env-a@@replacement-${id}`]
          }
        })
      }
    }
  })
  const first = Promise.withResolvers<void>()
  mocks.terminal.mockImplementation(({ worktreeId }: { worktreeId: string }) =>
    worktreeId === ids[0] ? first.promise : Promise.resolve()
  )
  const sleeping = runSleepWorktrees(ids)
  try {
    expect(mocks.terminal).toHaveBeenCalledTimes(2)
    expect(mocks.terminal).toHaveBeenLastCalledWith({ worktreeId: ids[1], environmentId: 'env-a' })
    expect(mocks.chat.mock.calls.map(([, , params]) => params.workspaceId)).toEqual(ids)
    await vi.waitFor(() => expect(store.getState().ptyIdsByTabId[ids[1]]).toEqual([]))
    expect(store.getState().suppressedPtyExitIds[`remote:env-a@@replacement-${ids[1]}`]).toBe(true)
    clearWorktreeSleepIntent(ids[1])
    expect(hasWorktreeSleepIntent(ids[1])).toBe(false)
    expect(mocks.suspend).not.toHaveBeenCalled()
  } finally {
    first.resolve()
  }
  const results = await sleeping
  expect(mocks.chat).toHaveBeenCalledTimes(2)
  expect(mocks.suspend).toHaveBeenCalledExactlyOnceWith({ workspaceId: ids[0] })
  expect(results.find((result) => result.workspaceId === ids[1])?.completed).toBe(false)
})

it('joins every admitted chat before VM suspend even when one terminal fails', async () => {
  const chat = Promise.withResolvers<{ stoppedSessionIds: string[] }>()
  mocks.chat.mockImplementation((_target, _method, { workspaceId }) =>
    workspaceId === ids[0]
      ? chat.promise
      : Promise.resolve({
          stoppedSessionIds: ['second'],
          failures: [{ reason: 'stop-unverifiable' }]
        })
  )
  mocks.terminal.mockRejectedValueOnce(new Error('terminal_failed'))
  const sleeping = runSleepWorktrees(ids)
  try {
    await vi.waitFor(() => expect(mocks.terminal).toHaveBeenCalledTimes(2))
    expect(mocks.chat).toHaveBeenCalledTimes(2)
    expect(mocks.suspend).not.toHaveBeenCalled()
  } finally {
    chat.resolve({ stoppedSessionIds: ['first'] })
  }
  const results = await sleeping
  expect(
    results.map(({ stoppedSessionIds, completed }) => ({ stoppedSessionIds, completed }))
  ).toEqual([
    { stoppedSessionIds: ['first'], completed: false },
    { stoppedSessionIds: ['second'], completed: false }
  ])
  expect(mocks.suspend).toHaveBeenCalledExactlyOnceWith({ workspaceId: ids[1] })
  expect(mocks.toast).toHaveBeenCalledOnce()
})

it('keeps the real chat-only twin refusal after synchronous browser cleanup', async () => {
  const browser = store.getState().shutdownWorktreeBrowsers
  store.setState({
    shutdownWorktreeBrowsers: (id) => {
      browser(id)
      seedTwin()
    }
  })
  const seedTwin = () =>
    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: ids[0], repoId: 'repo1', hostId: 'local' }),
          makeRuntimeOwnedWorktree(
            { id: ids[0], repoId: 'repo1', hostId: 'runtime:env-a' },
            'env-a'
          )
        ]
      },
      tabsByWorktree: {},
      ptyIdsByTabId: {}
    })
  store.setState({ browserTabsByWorktree: { [ids[0]]: [] } })
  await runSleepWorktrees([ids[0]])
  expect(store.getState().browserTabsByWorktree[ids[0]]).toBeUndefined()
  expect(mocks.chat).not.toHaveBeenCalled()
  expect(mocks.terminal).not.toHaveBeenCalled()
  expect(mocks.toast).toHaveBeenCalledOnce()
})
