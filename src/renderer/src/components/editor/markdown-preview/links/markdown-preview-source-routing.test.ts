import { expect, it } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { resolveMarkdownPreviewSourceWorktree } from './markdown-preview-source-routing'

it('resolves a paired preview only against its own host when workspace paths and IDs coincide', () => {
  const local = makeWorktree({ id: 'repo::/docs', repoId: 'repo', path: '/docs' })
  const paired = { ...local, runtimeOwnerEnvironmentId: 'paired' }
  const catalog = { docs: [local, paired] }

  expect(resolveMarkdownPreviewSourceWorktree(catalog, local.id, '/docs/a.md', 'paired')).toBe(
    paired
  )
  expect(resolveMarkdownPreviewSourceWorktree(catalog, local.id, '/docs/a.md', 'absent')).toBeNull()
})
