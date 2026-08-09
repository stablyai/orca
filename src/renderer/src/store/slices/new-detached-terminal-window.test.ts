import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const detachMock = vi.hoisted(() => vi.fn())
const ptyKillMock = vi.hoisted(() => vi.fn())

// @ts-expect-error -- minimal window.api stub for the store under test
globalThis.window = { api: { pane: { detach: detachMock }, pty: { kill: ptyKillMock } } }

import { createTestStore, seedStore, TEST_REPO } from './store-test-helpers'

function seedActiveWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    activeWorktreeId: 'wt-1',
    // Why: captureTerminalTabForWindowDetach derives the repoId from the
    // worktreeId prefix, so the seeded repo id must match 'wt-1' for a detach
    // seed to be built at all.
    repos: [{ ...TEST_REPO, id: 'wt-1', executionHostId: 'local' }],
    groupsByWorktree: {
      'wt-1': [{ id: 'group-1', worktreeId: 'wt-1', activeTabId: null, tabOrder: [] }]
    },
    activeGroupIdByWorktree: { 'wt-1': 'group-1' }
  })
}

describe('openNewDetachedTerminalWindow', () => {
  beforeEach(() => {
    detachMock.mockReset()
    detachMock.mockResolvedValue(undefined)
    ptyKillMock.mockReset()
    ptyKillMock.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a tab, waits for its PTY, detaches it, and closes the main-window tab', async () => {
    const store = createTestStore()
    seedActiveWorkspace(store)

    const promise = store.getState().openNewDetachedTerminalWindow('group-1')
    const tabId = store.getState().tabsByWorktree['wt-1']?.[0]?.id as string
    expect(tabId).toBeDefined()
    // The PTY arrives asynchronously, mirroring TerminalPane's spawn path.
    store.getState().updateTabPtyId(tabId, 'pty-1')
    await promise

    expect(detachMock).toHaveBeenCalledTimes(1)
    expect(detachMock).toHaveBeenCalledWith(
      tabId,
      expect.objectContaining({ worktreeId: 'wt-1', ptyId: 'pty-1' })
    )
    // The main-window tab is gone — the user never saw it flash in the strip.
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
    expect(store.getState().ptyIdsByTabId[tabId]).toBeUndefined()
    // The detached window owns the PTY now, so closing the tab must not kill it.
    expect(ptyKillMock).not.toHaveBeenCalled()
  })

  it('cleans up the tab when the PTY never arrives within the timeout', async () => {
    vi.useFakeTimers()
    const store = createTestStore()
    seedActiveWorkspace(store)

    const promise = store.getState().openNewDetachedTerminalWindow('group-1')
    const tabId = store.getState().tabsByWorktree['wt-1']?.[0]?.id as string
    expect(tabId).toBeDefined()

    await vi.advanceTimersByTimeAsync(5_000)
    await promise

    expect(detachMock).not.toHaveBeenCalled()
    expect(store.getState().tabsByWorktree['wt-1'] ?? []).toEqual([])
  })

  it('leaves the tab in the main window when the detach IPC fails', async () => {
    detachMock.mockRejectedValueOnce(new Error('detach ipc failed'))
    const store = createTestStore()
    seedActiveWorkspace(store)

    const promise = store.getState().openNewDetachedTerminalWindow('group-1')
    const tabId = store.getState().tabsByWorktree['wt-1']?.[0]?.id as string
    store.getState().updateTabPtyId(tabId, 'pty-1')
    await promise

    expect(detachMock).toHaveBeenCalledTimes(1)
    // Graceful degradation: the tab stays put and its PTY stays alive.
    expect(store.getState().tabsByWorktree['wt-1']?.map((tab) => tab.id)).toEqual([tabId])
    expect(ptyKillMock).not.toHaveBeenCalled()
  })
})
