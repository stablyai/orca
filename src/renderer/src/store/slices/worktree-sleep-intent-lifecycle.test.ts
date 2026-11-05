import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as intent from '@/lib/worktree-sleep-intent'
import './worktrees/teardown/worktree-purge-state'
import { createTestStore, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { resetStructuredAgentSessionReadOwnersForTests } from '@/components/native-chat/structured-agent-session-read-owner'

const { clearWorktreeSleepIntent, hasWorktreeSleepIntent, markWorktreeSleepIntent } = intent
const WORKTREE_ID = 'repo1::/path/wt1'
const FOLDER_KEY = 'folder:folder-1'

createStoreCascadesMockApi()

function seedWorktree(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    worktreesByRepo: {
      repo1: [makeWorktree({ id: WORKTREE_ID, repoId: 'repo1', path: '/path/wt1' })]
    },
    refreshGitHubForWorktree: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn()
  })
}

// Sleep intent keeps mounted panes cold after teardown; every wake route must release it or PTYs stay cold and exits cease counting as activity (#10205).
describe('worktree sleep intent lifecycle', () => {
  beforeEach(() => {
    clearWorktreeSleepIntent(WORKTREE_ID)
    clearWorktreeSleepIntent(FOLDER_KEY)
    resetStructuredAgentSessionReadOwnersForTests()
  })

  it('ignores a PTY bind that lands while the sleep teardown is in flight', async () => {
    const store = createTestStore()
    seedWorktree(store)
    const tab = store.getState().createTab(WORKTREE_ID, undefined, undefined, { activate: false })
    markWorktreeSleepIntent(WORKTREE_ID)
    const woke = vi.fn()
    intent.onWorktreeSleepIntentCleared(WORKTREE_ID, woke)

    await intent.withWorktreeSleepTeardown(WORKTREE_ID, async () => {
      store.getState().updateTabPtyId(tab.id, 'pty-late-spawn')
    })

    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(true)
    expect(woke).not.toHaveBeenCalled()
    store.getState().updateTabPtyId(tab.id, 'pty-after-teardown')
    expect(hasWorktreeSleepIntent(WORKTREE_ID)).toBe(false)
  })
})
