import { expect, it } from 'vitest'
import { makeWorktree } from '../worktree.test-fixture'
import { toVisibleWorktree } from './worktree-catalog-visibility'

it.each([
  { branch: 'refs/heads/feature/foo', path: '/repo/workspace', expected: 'feature/foo' },
  { branch: '', path: 'C:\\repos\\app\\folder', expected: 'folder' }
])('fills a missing name from branch or folder: $expected', ({ branch, path, expected }) => {
  const detected = {
    ...makeWorktree({
      id: 'workspace',
      repoId: 'repo',
      branch,
      path
    }),
    ownership: 'orca-managed' as const,
    selectedCheckout: false,
    visible: true
  }
  Reflect.deleteProperty(detected, 'displayName')

  expect(toVisibleWorktree(detected).displayName).toBe(expected)
})
