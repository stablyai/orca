import { describe, expect, it } from 'vitest'
import type { GitHubProjectSummary } from '../../../../shared/github/project-types'
import {
  GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES,
  filterGitHubProjectPickerProjects,
  isGitHubProjectPickerQueryTooLarge
} from './github-project-picker-filter'

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

  it('enforces the query budget by UTF-8 byte length', () => {
    const query = 'é'.repeat(GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES)

    expect(query.length).toBe(GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES)
    expect(isGitHubProjectPickerQueryTooLarge(query)).toBe(true)
    expect(
      filterGitHubProjectPickerProjects({
        projects: [project('stablyai', 1, 'Roadmap')],
        pinned: [],
        recent: [],
        query
      })
    ).toEqual([])
  })

  it('rejects oversized pasted project searches before reading project metadata', () => {
    const oversizedQuery = 'secret-project-picker-search'.repeat(
      GITHUB_PROJECT_PICKER_QUERY_MAX_BYTES
    )
    const candidate = {
      get owner(): string {
        throw new Error('oversized project searches must not scan owners')
      },
      get ownerType(): GitHubProjectSummary['ownerType'] {
        throw new Error('oversized project searches must not build project keys')
      },
      get number(): number {
        throw new Error('oversized project searches must not scan numbers')
      },
      get title(): string {
        throw new Error('oversized project searches must not scan titles')
      }
    } as GitHubProjectSummary

    expect(isGitHubProjectPickerQueryTooLarge(oversizedQuery)).toBe(true)
    expect(
      filterGitHubProjectPickerProjects({
        projects: [candidate],
        pinned: [],
        recent: [],
        query: oversizedQuery
      })
    ).toEqual([])
  })
})
