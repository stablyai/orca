import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/types'
import type { TaskProjectPickerGroup } from './task-page-default-repo-selection'
import { getProjectDetail, getSourceDetail } from './task-project-source-combobox'

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

function group(source: Repo): TaskProjectPickerGroup {
  return { projectKey: source.id, repo: source, sources: [source] }
}

describe('getSourceDetail', () => {
  it('shows the POSIX path for a WSL repo instead of the UNC share', () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    expect(getSourceDetail(wslRepo)).toBe('/home/u/app')
    expect(getSourceDetail(wslRepo, { label: 'Active' })).toBe('/home/u/app · Active')
  })

  it('leaves a non-WSL path unchanged', () => {
    expect(getSourceDetail(repo())).toBe('/Users/u/orca')
  })
})

describe('getProjectDetail', () => {
  it('shows the POSIX path for a single-source WSL group', () => {
    const wslRepo = repo({ path: '\\\\wsl.localhost\\Ubuntu\\home\\u\\app' })
    const detail = getProjectDetail(group(wslRepo), new Set([wslRepo.id]), false)
    expect(detail).toBe('/home/u/app')
  })
})
