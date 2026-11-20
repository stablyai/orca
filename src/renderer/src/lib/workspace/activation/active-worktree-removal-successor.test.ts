import { afterEach, describe, expect, it, vi } from 'vitest'
import { pickActiveWorktreeSuccessor } from './active-worktree-removal-successor'
import { createTestStore, seedStore } from '../../../store/testing/app-store-test-fixture'
import { makeWorktree } from '../../../store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '../../../store/repos/repo.test-fixture'
import { makeTerminalTab } from '../../../store/terminals/testing/terminal-row.test-fixture'
import {
  forgetWorktreeSleepIntent,
  markWorktreeSleepIntent
} from '@/lib/workspace/sleep/worktree-sleep-intent'

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

const slept = makeWorktree({ id: 'repo1::/slept', repoId: 'repo1', path: '/slept' })
const main = makeWorktree({
  id: 'repo1::/main',
  repoId: 'repo1',
  path: '/main',
  isMainWorktree: true
})
const removed = { id: 'repo1::/deleted', hostId: null, repoId: 'repo1', ownerHostIds: [] }

afterEach(() => {
  forgetWorktreeSleepIntent(slept.id)
  forgetWorktreeSleepIntent(main.id)
})

describe('pickActiveWorktreeSuccessor', () => {
  it('does not hand focus to a workspace the user slept, even when Hide sleeping is off', () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [slept, main] },
      showSleepingWorkspaces: true
    })
    markWorktreeSleepIntent(slept.id)
    markWorktreeSleepIntent(main.id)
    expect(pickActiveWorktreeSuccessor(store.getState(), removed, new Set())).toBeNull()

    forgetWorktreeSleepIntent(main.id)
    expect(pickActiveWorktreeSuccessor(store.getState(), removed, new Set())?.id).toBe(
      'repo1::/main'
    )
  })

  it('still hands focus to a slept workspace something else already woke', () => {
    const store = createTestStore()
    seedStore(store, {
      repos: [TEST_REPO],
      worktreesByRepo: { repo1: [slept, main] },
      tabsByWorktree: { [slept.id]: [makeTerminalTab({ id: 'tab-1', worktreeId: slept.id })] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      showSleepingWorkspaces: true
    })
    markWorktreeSleepIntent(slept.id)
    expect(pickActiveWorktreeSuccessor(store.getState(), removed, new Set())?.id).toBe(
      'repo1::/slept'
    )
  })
})
