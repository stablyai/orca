import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { buildTerminalCreateWindow } from '../ipc-events-terminal-create-window-test-fixtures'
import type * as TerminalCommandState from './terminal-command-state'
import type { TerminalTabCreateReply } from '../../../../shared/terminal-reveal-identity'

const WORKTREE_ID = 'repo1::/path/visible'
const HIDDEN_ID = 'repo1::/path/hidden'
const DUPLICATE_ID = 'repo2::/path/visible'
let store: ReturnType<typeof createTestStore>
const reply = vi.fn<(data: TerminalTabCreateReply) => void>()
const mount = vi.fn()
const activate = vi.fn()

vi.mock('../../store', () => ({ useAppStore: { getState: () => store.getState() } }))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: (...args: unknown[]) => mount(...args)
}))
vi.mock('./terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalCommandState>()),
  activateTerminalInitiatedWorktree: (...args: unknown[]) => activate(...args),
  focusTerminalInitiatedTab: vi.fn()
}))

import { registerTerminalRequestIpcBridge } from './terminal-request-ipc-bridge'

type Request = Parameters<Parameters<typeof window.api.ui.onRequestTerminalCreate>[0]>[0]
let request: (data: Request) => void

beforeEach(() => {
  vi.clearAllMocks()
  store = createTestStore()
  seedStore(store, {
    worktreesByRepo: { repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1' })] },
    detectedWorktreesByRepo: {
      repo1: {
        repoId: 'repo1',
        source: 'git',
        authoritative: true,
        worktrees: [
          {
            ...makeWorktree({ id: HIDDEN_ID, repoId: 'repo1', path: '/path/hidden' }),
            ownership: 'external',
            selectedCheckout: false,
            visible: false
          }
        ]
      }
    }
  })
  store.setState({
    repos: [...store.getState().repos, { ...store.getState().repos[0], id: 'repo2' }]
  })
  const listener = { current: null as unknown }
  vi.stubGlobal(
    'window',
    buildTerminalCreateWindow({
      dispatchEvent: vi.fn(),
      replyTerminalCreate: reply,
      requestTerminalCreateListenerRef: listener,
      createTerminalListenerRef: { current: null },
      focusTerminalListenerRef: { current: null },
      newTerminalTabListenerRef: { current: null }
    })
  )
  registerTerminalRequestIpcBridge([])
  request = listener.current as typeof request
})

afterEach(() => vi.unstubAllGlobals())

describe('renderer terminal create admission', () => {
  it.each([
    [HIDDEN_ID, 'background'],
    [HIDDEN_ID, 'focused'],
    [DUPLICATE_ID, 'background'],
    [DUPLICATE_ID, 'focused']
  ] as const)(
    'refuses %s (%s) without creating or queueing anything',
    (worktreeId, presentation) => {
      const createTab = vi.spyOn(store.getState(), 'createTab')
      const queue = vi.spyOn(store.getState(), 'queueTabStartupCommand')
      const before = store.getState()

      request({ requestId: 'hidden', worktreeId, presentation, command: 'codex' })

      expect(reply).toHaveBeenCalledExactlyOnceWith({
        requestId: 'hidden',
        errorCode: 'worktree_not_renderable',
        error: expect.stringContaining('Show it in Non-Orca worktrees')
      })
      expect(createTab).not.toHaveBeenCalled()
      expect(queue).not.toHaveBeenCalled()
      expect(mount).not.toHaveBeenCalled()
      expect(activate).not.toHaveBeenCalled()
      expect(store.getState()).toBe(before)
    }
  )

  it('creates a visible background tab with its startup command', () => {
    request({
      requestId: 'visible',
      worktreeId: WORKTREE_ID,
      presentation: 'background',
      command: 'codex'
    })
    const tab = store.getState().tabsByWorktree[WORKTREE_ID][0]
    expect(reply).toHaveBeenCalledExactlyOnceWith({
      requestId: 'visible',
      tabId: tab.id,
      title: tab.title
    })
    expect(store.getState().pendingStartupByTabId[tab.id]).toEqual({ command: 'codex' })
    expect(mount).toHaveBeenCalledWith({ worktreeId: WORKTREE_ID, tabIds: [tab.id] })
  })

  it('retires the new tab and queued command if the success reply throws', () => {
    const sibling = store.getState().createTab(WORKTREE_ID)
    store.getState().queueTabStartupCommand(sibling.id, { command: 'keep me' })
    const close = vi.spyOn(store.getState(), 'closeTab')
    reply.mockImplementationOnce(() => {
      throw new Error('Reply transport failed')
    })

    request({
      requestId: 'failed',
      worktreeId: WORKTREE_ID,
      presentation: 'background',
      command: 'codex'
    })

    expect(close).toHaveBeenCalledWith(expect.any(String), {
      reason: 'cleanup',
      recordInteraction: false
    })
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toEqual([sibling])
    expect(store.getState().pendingStartupByTabId).toEqual({ [sibling.id]: { command: 'keep me' } })
    expect(store.getState().unifiedTabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(store.getState().recentlyClosedTerminalTabsByWorktree[WORKTREE_ID] ?? []).toEqual([])
    expect(reply).toHaveBeenLastCalledWith({ requestId: 'failed', error: 'Reply transport failed' })
  })

  it('cleans up when creation fails after allocating the tab but before queueing', () => {
    vi.spyOn(store.getState(), 'setTabCustomTitle').mockImplementationOnce(() => {
      throw new Error('Title failed')
    })
    request({
      requestId: 'failed',
      worktreeId: WORKTREE_ID,
      presentation: 'background',
      title: 'Agent',
      command: 'codex'
    })
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toEqual([])
    expect(store.getState().pendingStartupByTabId).toEqual({})
    expect(reply).toHaveBeenLastCalledWith({ requestId: 'failed', error: 'Title failed' })
  })
})
