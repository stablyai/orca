import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getRepositoryPaneSearchEntries } from './repository-search'

const baseRepo: Repo = {
  id: 'repo-1',
  path: '/work/notes',
  displayName: 'Notes',
  badgeColor: '#000',
  addedAt: 0
}

function hasClaudeAccountEntry(repo: Repo): boolean {
  return getRepositoryPaneSearchEntries(repo).some((entry) => entry.title === 'Claude Account')
}

describe('repository search: Claude Account', () => {
  it('lists the section for folder projects as well as git projects', () => {
    expect(hasClaudeAccountEntry(baseRepo)).toBe(true)
    expect(hasClaudeAccountEntry({ ...baseRepo, kind: 'folder' })).toBe(true)
  })
})
