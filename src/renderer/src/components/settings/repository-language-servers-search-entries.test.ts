import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getRepositoryPaneSearchEntries } from './repository-search'

const repo: Repo = {
  id: 'r',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

describe('language server settings search', () => {
  it.each([
    ['git repository', repo],
    ['folder workspace', { ...repo, kind: 'folder' as const }]
  ])('lets "ruby-lsp" find the repository pane for a %s', (_label, candidate) => {
    const entries = getRepositoryPaneSearchEntries(candidate, { isLocalWindowsProject: false })
    expect(entries.some((entry) => entry.keywords?.includes('ruby-lsp'))).toBe(true)
  })
})
