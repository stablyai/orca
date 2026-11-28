import { describe, expect, it } from 'vitest'
import { matchesGitHubWorkItemTarget, resolveGitHubWorkItemTarget } from './work-item-target'

const enterprise = { host: 'git.example.com', owner: 'o', repo: 'r' }

describe('matchesGitHubWorkItemTarget', () => {
  it('accepts GHES items whose web host differs from the API host they were read from', () => {
    const target = { repository: enterprise, type: 'pr' as const, number: 5 }
    expect(
      matchesGitHubWorkItemTarget(
        { url: 'https://github.example.com/o/r/pull/5', type: 'pr', number: 5, prRepo: enterprise },
        target
      )
    ).toBe(true)
    expect(
      matchesGitHubWorkItemTarget(
        {
          url: 'https://github.example.com/o/r/issues/5',
          type: 'issue',
          number: 5,
          apiHost: enterprise.host
        },
        { ...target, type: 'issue' }
      )
    ).toBe(true)
  })

  it('takes a GHES issue owner/repo from its URL, not the repository that listed it', () => {
    const issue = {
      url: 'https://github.example.com/o/renamed/issues/5',
      type: 'issue' as const,
      number: 5,
      apiHost: enterprise.host
    }
    const target = resolveGitHubWorkItemTarget(issue)
    expect(target?.repository).toEqual({ host: enterprise.host, owner: 'o', repo: 'renamed' })
    expect(target && matchesGitHubWorkItemTarget(issue, target)).toBe(true)
  })

  it('still rejects another repository or a dotcom read answered by another host', () => {
    const target = { repository: enterprise, type: 'pr' as const, number: 5 }
    expect(
      matchesGitHubWorkItemTarget(
        {
          url: 'https://github.example.com/fork/r/pull/5',
          type: 'pr',
          number: 5,
          prRepo: enterprise
        },
        target
      )
    ).toBe(false)
    expect(
      matchesGitHubWorkItemTarget(
        { url: 'https://github.example.com/o/r/issues/5', type: 'issue', number: 5 },
        { ...target, type: 'issue' }
      )
    ).toBe(false)
    const dotcom = { owner: 'o', repo: 'r' }
    expect(
      matchesGitHubWorkItemTarget(
        { url: 'https://git.example.com/o/r/pull/5', type: 'pr', number: 5, prRepo: dotcom },
        { repository: dotcom, type: 'pr', number: 5 }
      )
    ).toBe(false)
  })
})
