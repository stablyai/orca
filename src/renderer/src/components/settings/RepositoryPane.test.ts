import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { getRepositoryPaneSearchEntries } from './RepositoryPane'
import { matchesSettingsSearch } from './settings-search'

const repo: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

describe('RepositoryPane search entries', () => {
  it('keeps renamed hook sections reachable through settings search', () => {
    const entries = getRepositoryPaneSearchEntries(repo)

    expect(matchesSettingsSearch('setup command', entries)).toBe(true)
    expect(matchesSettingsSearch('archive command', entries)).toBe(true)
    expect(matchesSettingsSearch('advanced', entries)).toBe(true)
    expect(matchesSettingsSearch('command source', entries)).toBe(true)
    expect(matchesSettingsSearch('local settings commands', entries)).toBe(true)
  })
})
