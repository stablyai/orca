import { describe, expect, it } from 'vitest'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'

const WORKTREE_ID = 'repo1::/path/wt1'

describe('createTab launch-agent layout', () => {
  it('mints a single-leaf layout so an unmounted phone-launched agent can appear in the sidebar', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const tab = store.getState().createTab(WORKTREE_ID, undefined, undefined, {
      launchAgent: 'codex',
      activate: false
    })
    const layout = store.getState().terminalLayoutsByTabId[tab.id]

    expect(tab.launchAgent).toBe('codex')
    expect(layout?.root).toEqual({ type: 'leaf', leafId: expect.any(String) })
    expect(layout?.activeLeafId).toBe(layout?.root?.type === 'leaf' ? layout.root.leafId : null)
  })

  it('keeps a blank terminal rootless until its pane mounts', () => {
    const store = createTestStore()
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
      }
    })

    const tab = store.getState().createTab(WORKTREE_ID, undefined, undefined, { activate: false })
    expect(store.getState().terminalLayoutsByTabId[tab.id]).toEqual({
      root: null,
      activeLeafId: null,
      expandedLeafId: null
    })
  })
})
