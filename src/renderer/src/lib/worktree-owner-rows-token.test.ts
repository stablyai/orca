import { expect, it } from 'vitest'
import { worktreeOwnerRowsTokenOf } from './worktree-owner-rows-token'

const row = { id: 'repo::/w', repoId: 'repo', hostId: 'local' as const, sortOrder: 1 }

it('keeps the token across non-owner row patches and changes it for owner changes', () => {
  const token = worktreeOwnerRowsTokenOf({ repo: [row] })
  const reranked = { ...row, sortOrder: 2 }
  expect(worktreeOwnerRowsTokenOf({ repo: [reranked] })).toBe(token)
  expect(worktreeOwnerRowsTokenOf({ repo: [{ ...row, hostId: 'runtime:env' }] })).not.toBe(token)
  expect(worktreeOwnerRowsTokenOf({ other: [row] })).not.toBe(token)
})
