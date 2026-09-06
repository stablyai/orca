import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import { getRepositoryPaneSearchEntries } from './repository-search'
import {
  getRepositoryWorkspaceTrustSearchEntries,
  getRepositoryWorkspaceTrustSearchTitle
} from './repository-workspace-trust-search-entries'
import { matchesSettingsSearch } from './settings-search'

const repo: Repo = {
  id: 'repo-1',
  path: '/home/dev/work/proj',
  displayName: 'Example Repo',
  badgeColor: '#000000',
  addedAt: 1,
  kind: 'git'
}

describe('repository workspace trust search entries', () => {
  it('describes the trust section under its own searchable title', () => {
    const entries = getRepositoryWorkspaceTrustSearchEntries(repo)

    expect(entries).toHaveLength(1)
    expect(entries[0].title).toBe(getRepositoryWorkspaceTrustSearchTitle())
    expect(entries[0].keywords).toContain(repo.path)
  })

  it('is reachable from the repository pane search index', () => {
    const entries = getRepositoryPaneSearchEntries(repo)

    expect(matchesSettingsSearch('workspace trust', entries)).toBe(true)
    expect(matchesSettingsSearch('revoke trust', entries)).toBe(true)
    expect(matchesSettingsSearch('untrusted', entries)).toBe(true)
  })

  // AGENTS.md folder-workspace rule: trust is path-scoped, so a folder-opened
  // project must stay searchable exactly like a git one.
  it('stays in the index for a folder-opened project', () => {
    const entries = getRepositoryPaneSearchEntries({ ...repo, kind: 'folder' })

    expect(matchesSettingsSearch('workspace trust', entries)).toBe(true)
  })
})
