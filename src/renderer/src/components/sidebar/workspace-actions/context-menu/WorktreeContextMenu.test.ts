import { describe, expect, it } from 'vitest'
import { hasWorktreeParentLink } from './worktree-context-menu-policy'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'

describe('parent picker context menu affordance', () => {
  it('offers unlink for a folder workspace under a bot, keyed by its own id', () => {
    const folder = makeWorktree({
      id: 'folder:notes',
      repoId: 'folder-group:notes',
      path: '/notes'
    })
    const link = {
      childWorkspaceKey: 'folder:notes' as const,
      childInstanceId: null,
      parentWorkspaceKey: 'folder:atlas-home' as const,
      parentInstanceId: null,
      origin: 'orchestration' as const,
      capture: { source: 'orchestration-context' as const, confidence: 'explicit' as const },
      createdAt: 1
    }
    expect(hasWorktreeParentLink(folder, {}, { 'folder:notes': link })).toBe(true)
  })
})
