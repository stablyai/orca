import { describe, expect, it } from 'vitest'
import type { GitHubProjectSummary } from '../../../../../shared/github/projects/project-types'
import { filterGitHubProjectPickerProjects } from './github-project-picker-filter'

function project(
  owner: string,
  number: number,
  title: string,
  ownerType: GitHubProjectSummary['ownerType'] = 'organization',
  host?: string
): GitHubProjectSummary {
  return {
    id: `${owner}-${number}`,
    ...(host ? { host } : {}),
    owner,
    ownerType,
    number,
    title,
    url: `https://github.com/orgs/${owner}/projects/${number}`,
    source: 'viewer'
  }
}

describe('github-project-picker-filter', () => {
  it('does not hide a GHES project behind a same-named github.com pin', () => {
    const dotCom = project('acme', 1, 'Dotcom')
    const enterprise = project('acme', 1, 'Enterprise', 'organization', 'ghe.example')

    expect(
      filterGitHubProjectPickerProjects({
        projects: [dotCom, enterprise],
        pinned: [{ owner: 'acme', ownerType: 'organization', number: 1 }],
        recent: [],
        query: ''
      })
    ).toEqual([enterprise])
  })
})
