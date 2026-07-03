import { describe, expect, it } from 'vitest'
import {
  getDuplicateRepoDisplayNames,
  normalizeRepoDisplayNameKey
} from './duplicate-repo-display-names'
import type { Repo } from '../../../shared/types'

function repo(id: string, displayName: string): Repo {
  return {
    id,
    path: `/tmp/${id}`,
    displayName,
    badgeColor: '#111111',
    addedAt: 1
  }
}

describe('normalizeRepoDisplayNameKey', () => {
  it('trims and lowercases display names', () => {
    expect(normalizeRepoDisplayNameKey('  Orca  ')).toBe('orca')
  })
})

describe('getDuplicateRepoDisplayNames', () => {
  it('detects case-insensitive trimmed duplicate display names', () => {
    const duplicates = getDuplicateRepoDisplayNames([
      repo('repo-1', ' Orca '),
      repo('repo-2', 'orca'),
      repo('repo-3', 'Docs')
    ])

    expect(duplicates).toEqual(new Set(['orca']))
  })

  it('ignores unique names and returns only names that appear more than once', () => {
    const duplicates = getDuplicateRepoDisplayNames([
      repo('repo-1', 'Orca'),
      repo('repo-2', 'Docs'),
      repo('repo-3', 'Docs'),
      repo('repo-4', 'Tools'),
      repo('repo-5', 'Docs')
    ])

    expect(duplicates).toEqual(new Set(['docs']))
  })

  it('handles empty and single-repo lists', () => {
    expect(getDuplicateRepoDisplayNames([])).toEqual(new Set())
    expect(getDuplicateRepoDisplayNames([repo('repo-1', 'Orca')])).toEqual(new Set())
  })
})
