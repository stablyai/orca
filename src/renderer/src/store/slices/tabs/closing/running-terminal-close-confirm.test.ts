import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  RunningTerminalCloseConfirmRequest,
  RunningTerminalCloseConfirmState
} from './running-terminal-close-confirm'

type CloseConfirmStore = {
  getState: () => RunningTerminalCloseConfirmState
}

const INTER_REQUEST_ACTION_GUARD_MS = 350

async function loadStore(): Promise<CloseConfirmStore> {
  vi.resetModules()
  const module = await import('./running-terminal-close-confirm')
  return { getState: module.useRunningTerminalCloseConfirmStore.getState }
}

function request(
  store: CloseConfirmStore,
  overrides: Pick<RunningTerminalCloseConfirmRequest, 'terminalTabId' | 'onConfirm'> &
    Partial<RunningTerminalCloseConfirmRequest>
): void {
  store.getState().requestRunningTerminalCloseConfirm({ copyKind: 'agent', ...overrides })
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000 })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('merged running-work consent', () => {
  it('promotes a visible idle prompt when a running-work close merges into it', async () => {
    const store = await loadStore()
    const idleConfirm = vi.fn()
    const runningConfirm = vi.fn()
    request(store, { terminalTabId: 'tab-1', copyKind: 'idle', onConfirm: idleConfirm })
    request(store, { terminalTabId: 'tab-1', copyKind: 'agent', onConfirm: runningConfirm })

    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('agent')

    // The in-place upgrade is guarded; confirm after the guard to check the callback ordering.
    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()

    expect(runningConfirm).toHaveBeenCalledTimes(1)
    expect(idleConfirm).toHaveBeenCalledTimes(1)
    // The consented close runs first so the idle re-check cannot prompt again for the same tab.
    expect(runningConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      idleConfirm.mock.invocationCallOrder[0]!
    )
  })

  it('carries the running request workspace and sleep offer into the promoted prompt', async () => {
    const store = await loadStore()
    request(store, { terminalTabId: 'tab-1', copyKind: 'idle', onConfirm: vi.fn() })
    request(store, {
      terminalTabId: 'tab-1',
      copyKind: 'agent',
      worktreeId: 'worktree-1',
      canSleepInstead: true,
      onConfirm: vi.fn()
    })

    const merged = store.getState().runningTerminalCloseConfirm
    expect(merged?.copyKind).toBe('agent')
    expect(merged?.worktreeId).toBe('worktree-1')
    expect(merged?.canSleepInstead).toBe(true)
  })

  it('ignores an immediate confirm after an in-place idle-to-running promotion', async () => {
    const store = await loadStore()
    const idleConfirm = vi.fn()
    const runningConfirm = vi.fn()
    request(store, { terminalTabId: 'tab-1', copyKind: 'idle', onConfirm: idleConfirm })
    request(store, { terminalTabId: 'tab-1', copyKind: 'agent', onConfirm: runningConfirm })

    store.getState().confirmRunningTerminalClose()
    expect(runningConfirm).not.toHaveBeenCalled()
    expect(idleConfirm).not.toHaveBeenCalled()
    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('agent')

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()
    expect(runningConfirm).toHaveBeenCalledTimes(1)
    expect(idleConfirm).toHaveBeenCalledTimes(1)
  })

  it('does not guard a running-only merge', async () => {
    const store = await loadStore()
    const firstConfirm = vi.fn()
    const secondConfirm = vi.fn()
    request(store, { terminalTabId: 'tab-1', copyKind: 'agent', onConfirm: firstConfirm })
    request(store, { terminalTabId: 'tab-1', copyKind: 'command', onConfirm: secondConfirm })

    store.getState().confirmRunningTerminalClose()
    expect(firstConfirm).toHaveBeenCalledTimes(1)
    expect(secondConfirm).toHaveBeenCalledTimes(1)
  })

  it('promotes a queued idle prompt when a running-work close merges into it', async () => {
    const store = await loadStore()
    const idleConfirm = vi.fn()
    const queuedIdleConfirm = vi.fn()
    const queuedRunningConfirm = vi.fn()
    request(store, { terminalTabId: 'tab-1', copyKind: 'idle', onConfirm: idleConfirm })
    request(store, { terminalTabId: 'tab-2', copyKind: 'idle', onConfirm: queuedIdleConfirm })
    request(store, {
      terminalTabId: 'tab-2',
      copyKind: 'command',
      onConfirm: queuedRunningConfirm
    })

    store.getState().confirmRunningTerminalClose()

    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('command')

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()

    expect(queuedRunningConfirm).toHaveBeenCalledTimes(1)
    expect(queuedIdleConfirm).toHaveBeenCalledTimes(1)
    expect(queuedRunningConfirm.mock.invocationCallOrder[0]).toBeLessThan(
      queuedIdleConfirm.mock.invocationCallOrder[0]!
    )
  })

  it('keeps idle copy and both cancel callbacks for an idle-only merge', async () => {
    const store = await loadStore()
    const firstCancel = vi.fn()
    const secondCancel = vi.fn()
    request(store, {
      terminalTabId: 'tab-1',
      copyKind: 'idle',
      onConfirm: vi.fn(),
      onCancel: firstCancel
    })
    request(store, {
      terminalTabId: 'tab-1',
      copyKind: 'idle',
      onConfirm: vi.fn(),
      onCancel: secondCancel
    })

    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('idle')
    expect(store.getState().dismissRunningTerminalClose()).toBe(true)
    expect(firstCancel).toHaveBeenCalledTimes(1)
    expect(secondCancel).toHaveBeenCalledTimes(1)
  })
})

describe('replacement prompt action guard', () => {
  it('ignores an immediate action on a prompt opened by the confirmed callback', async () => {
    const store = await loadStore()
    const replacementConfirm = vi.fn()
    request(store, {
      terminalTabId: 'chat-1',
      copyKind: 'idle-chat',
      onConfirm: () => {
        request(store, {
          terminalTabId: 'chat-2',
          copyKind: 'chat-agent',
          onConfirm: replacementConfirm
        })
      }
    })

    store.getState().confirmRunningTerminalClose()
    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('chat-agent')

    // A held Enter or second click on the same primary button must not accept the unseen prompt.
    store.getState().confirmRunningTerminalClose()
    expect(replacementConfirm).not.toHaveBeenCalled()
    expect(store.getState().runningTerminalCloseConfirm).not.toBeNull()

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()
    expect(replacementConfirm).toHaveBeenCalledTimes(1)
  })

  it('guards a running prompt that an idle recheck opens after its callback returns', async () => {
    const store = await loadStore()
    const runningConfirm = vi.fn()
    request(store, {
      terminalTabId: 'tab-1',
      copyKind: 'idle',
      onConfirm: () => {
        // The busy recheck settles after an async process probe, i.e. after onConfirm returned.
        setTimeout(() => {
          request(store, {
            terminalTabId: 'tab-1',
            copyKind: 'agent',
            guardWhenVisible: true,
            onConfirm: runningConfirm
          })
        }, 0)
      }
    })

    store.getState().confirmRunningTerminalClose()
    vi.advanceTimersByTime(1)
    expect(store.getState().runningTerminalCloseConfirm?.copyKind).toBe('agent')

    store.getState().confirmRunningTerminalClose()
    expect(runningConfirm).not.toHaveBeenCalled()
    expect(store.getState().runningTerminalCloseConfirm).not.toBeNull()

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()
    expect(runningConfirm).toHaveBeenCalledTimes(1)
  })

  it('still confirms a queued prompt after the reveal guard expires', async () => {
    const store = await loadStore()
    const firstConfirm = vi.fn()
    const secondConfirm = vi.fn()
    request(store, { terminalTabId: 'tab-1', copyKind: 'idle', onConfirm: firstConfirm })
    request(store, { terminalTabId: 'tab-2', copyKind: 'idle', onConfirm: secondConfirm })

    store.getState().confirmRunningTerminalClose()
    expect(store.getState().runningTerminalCloseConfirm?.terminalTabId).toBe('tab-2')

    store.getState().confirmRunningTerminalClose()
    expect(secondConfirm).not.toHaveBeenCalled()

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()
    expect(secondConfirm).toHaveBeenCalledTimes(1)
  })
})

describe('confirm-all running-work opt-out', () => {
  it('accepts running work, keeps idle prompts ordered, and guards the revealed idle prompt', async () => {
    const store = await loadStore()
    const visibleRunning = vi.fn()
    const firstIdleChat = vi.fn()
    const secondIdle = vi.fn()
    const queuedRunning = vi.fn()
    request(store, { terminalTabId: 'running-1', copyKind: 'agent', onConfirm: visibleRunning })
    request(store, {
      terminalTabId: 'idle-chat-1',
      copyKind: 'idle-chat',
      onConfirm: firstIdleChat
    })
    request(store, { terminalTabId: 'idle-1', copyKind: 'idle', onConfirm: secondIdle })
    request(store, { terminalTabId: 'running-2', copyKind: 'command', onConfirm: queuedRunning })

    store.getState().confirmAllRunningTerminalCloses()

    // The opt-out covers running work only; idle prompts stay queued in their original order.
    expect(visibleRunning).toHaveBeenCalledTimes(1)
    expect(queuedRunning).toHaveBeenCalledTimes(1)
    expect(firstIdleChat).not.toHaveBeenCalled()
    expect(secondIdle).not.toHaveBeenCalled()
    expect(store.getState().runningTerminalCloseConfirm?.terminalTabId).toBe('idle-chat-1')

    // A held Enter aimed at the opt-out must not accept the unseen idle prompt.
    store.getState().confirmRunningTerminalClose()
    expect(firstIdleChat).not.toHaveBeenCalled()

    vi.advanceTimersByTime(INTER_REQUEST_ACTION_GUARD_MS)
    store.getState().confirmRunningTerminalClose()
    expect(firstIdleChat).toHaveBeenCalledTimes(1)
    expect(store.getState().runningTerminalCloseConfirm?.terminalTabId).toBe('idle-1')
  })
})
