import { expect, it } from 'vitest'
import { createTestStore } from '../store/testing/app-store-test-fixture'
import { TEST_REPO } from '../store/repos/repo.test-fixture'
import { makeWorktree } from '../store/slices/worktrees/worktree.test-fixture'
import { getLocalPreflightContext } from './local-preflight-context'

it('rebuilds against a replacement snapshot', () => {
  const worktree = makeWorktree({
    id: 'repo1::/worktree',
    repoId: TEST_REPO.id,
    path: String.raw`\\wsl.localhost\Ubuntu\home\alice\worktree`
  })
  const state = {
    ...createTestStore().getState(),
    activeRepoId: TEST_REPO.id,
    activeWorktreeId: worktree.id,
    repos: [TEST_REPO],
    worktreesByRepo: { [TEST_REPO.id]: [worktree] }
  }

  expect(getLocalPreflightContext(state, 'darwin')).toEqual({ wslDistro: 'Ubuntu' })
  expect(
    getLocalPreflightContext(
      {
        ...state,
        worktreesByRepo: {
          [TEST_REPO.id]: [
            { ...worktree, path: String.raw`\\wsl.localhost\Debian\home\alice\moved` }
          ]
        }
      },
      'darwin'
    )
  ).toEqual({ wslDistro: 'Debian' })
})
