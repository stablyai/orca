import { describe, expect, it } from 'vitest'
import { indexHiddenProjects } from '../../../../../../shared/hidden-projects'
import type { Repo } from '../../../../../../shared/repo-types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { getWorktreePaletteSearchScope } from './worktree-palette-search'

const repo = (id: string, overrides: Partial<Repo> = {}): Repo => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: '',
  addedAt: 0,
  ...overrides
})

describe('getWorktreePaletteSearchScope', () => {
  it('lets a typed search recover filtered workspaces but never a hidden project’s', () => {
    const listed = makeWorktree({ id: 'a::/a', repoId: 'a', path: '/a' })
    const tucked = makeWorktree({ id: 'h::/h', repoId: 'h', path: '/h' })
    const hiddenProjects = indexHiddenProjects([repo('a'), repo('h', { hiddenAt: 1 })], 'local')

    const scope = getWorktreePaletteSearchScope({
      hasQuery: true,
      allWorktrees: [listed, tucked],
      emptyQueryWorktrees: [],
      hiddenProjects
    })

    expect(scope.map((worktree) => worktree.id)).toEqual(['a::/a'])
  })
})
