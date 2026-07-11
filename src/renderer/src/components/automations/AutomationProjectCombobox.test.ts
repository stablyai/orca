import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { getRepoDetail } from './AutomationProjectCombobox'

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/Users/u/orca',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1,
    ...overrides
  }
}

describe('getRepoDetail', () => {
  it('shows the POSIX path for a WSL repo instead of the UNC share', () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    expect(getRepoDetail(wslRepo)).toBe('/home/u/app')
    expect(getRepoDetail(wslRepo, 'WSL')).toBe('WSL · /home/u/app')
  })

  it('leaves a non-WSL path unchanged', () => {
    expect(getRepoDetail(repo())).toBe('/Users/u/orca')
  })
})
