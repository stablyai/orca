import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'

function seedWorktreeWithTab(store: ReturnType<typeof createTestStore>): string {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    }
  })
  return store.getState().createTab(WORKTREE_ID).id
}

// Why this suite exists: TerminalPane snapshots pendingStartupByTabId in a useState initializer,
// so whatever is missing there at mount is missing for good. The command must therefore survive
// every store event that can precede its owning pane's fresh spawn, or a quick command leaves the
// user a titled tab sitting at a bare prompt (STA-4876).
describe('queued startup command retention', () => {
  it('survives a recovery remount so the next mount can still deliver it', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Why: binding is pane-scoped but this map is tab-scoped. A tab routinely runs several panes
  // (setup/issue splits land on the same tabId), and the sibling often binds first — if a bind
  // spent the command, the pane that actually owns it would find an empty slot on remount.
  it('is not spent by a sibling pane binding a pty to the same tab', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().updateTabPtyId(tabId, 'pty-sibling')

    expect(store.getState().pendingStartupByTabId[tabId]).toEqual({ command: 'echo hi' })
  })

  // Only the owning pane spends it, via this action, once its own fresh spawn exists.
  it('is spent through consumeTabStartupCommand and does not replay afterwards', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    expect(store.getState().consumeTabStartupCommand(tabId)).toEqual({ command: 'echo hi' })

    store.getState().remountTerminalTabForRecovery(tabId)
    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
    expect(store.getState().consumeTabStartupCommand(tabId)).toBeNull()
  })

  // Why: retention is bounded by tab lifetime, so a spawn that never binds cannot leak forever.
  it('is dropped when the tab closes without ever spawning', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    store.getState().queueTabStartupCommand(tabId, { command: 'echo hi' })

    store.getState().closeTab(tabId)

    expect(store.getState().pendingStartupByTabId[tabId]).toBeUndefined()
  })

  it('leaves a sibling tab’s queued command alone', () => {
    const store = createTestStore()
    const tabId = seedWorktreeWithTab(store)
    const siblingId = store.getState().createTab(WORKTREE_ID).id
    store.getState().queueTabStartupCommand(tabId, { command: 'echo mine' })
    store.getState().queueTabStartupCommand(siblingId, { command: 'echo theirs' })

    store.getState().consumeTabStartupCommand(tabId)

    expect(store.getState().pendingStartupByTabId[siblingId]).toEqual({ command: 'echo theirs' })
  })
})
