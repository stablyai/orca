import { describe, expect, it } from 'vitest'
import {
  githubFullNameKey,
  selectCloudOnlyRepositories
} from './use-orca-cloud-github-repositories'
import { filterCloudRepos } from '@/components/new-workspace/ProjectComboboxCloudSection'

const repo = (fullName: string) => ({
  fullName,
  url: `https://github.com/${fullName}`,
  private: true
})

describe('GitHub-only projects (D4)', () => {
  it('lists only repositories with no clone here, matching remotes case-insensitively', () => {
    expect(
      selectCloudOnlyRepositories(
        [repo('acme/web'), repo('acme/infra'), repo('Acme/Billing')],
        ['https://github.com/acme/web', 'https://github.com/acme/billing.git', null]
      ).map((r) => r.fullName)
    ).toEqual(['acme/infra'])
  })

  it('keys GitHub URLs by owner/name and ignores everything else', () => {
    expect(githubFullNameKey('https://github.com/Acme/Web.git')).toBe('acme/web')
    expect(githubFullNameKey('https://gitlab.com/acme/web')).toBeNull()
  })

  it('filters the picker section by a typed query', () => {
    expect(filterCloudRepos([repo('acme/web'), repo('acme/infra')], 'INF')).toEqual([
      repo('acme/infra')
    ])
    expect(filterCloudRepos([repo('acme/web')], '  ')).toHaveLength(1)
  })
})
