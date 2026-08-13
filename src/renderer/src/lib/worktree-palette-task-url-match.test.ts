import { describe, expect, it } from 'vitest'
import type { Repo, Worktree } from '../../../shared/types'
import {
  getCmdJTaskUrlCreatePreview,
  matchWorktreePaletteTaskUrl,
  parseCmdJTaskSourceUrl,
  withResolvedCmdJGitHubPreview
} from './worktree-palette-task-url-match'

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/tmp/wt-1',
    head: 'abc123',
    branch: 'refs/heads/feature/url-match',
    isBare: false,
    isMainWorktree: false,
    displayName: 'URL match',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

const orcaRepo: Repo = {
  id: 'repo-1',
  path: '/repo/orca',
  displayName: 'stablyai/orca',
  badgeColor: '#22c55e',
  addedAt: 0
}

describe('parseCmdJTaskSourceUrl', () => {
  it('parses GitHub issue and pull URLs', () => {
    expect(parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/14198')).toEqual({
      provider: 'github',
      link: {
        slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        type: 'issue',
        number: 14198
      }
    })
    expect(parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')).toEqual({
      provider: 'github',
      link: {
        slug: { owner: 'stablyai', repo: 'orca', host: 'github.com' },
        type: 'pr',
        number: 12789
      }
    })
  })

  it('parses Linear, GitLab, and Jira URLs', () => {
    expect(
      parseCmdJTaskSourceUrl(
        'https://linear.app/stably/issue/STA-4052/agent-terminals-disappearing-randomly'
      )
    ).toEqual({
      provider: 'linear',
      intent: { identifier: 'STA-4052', organizationUrlKey: 'stably' }
    })
    expect(
      parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    ).toMatchObject({
      provider: 'gitlab',
      link: { type: 'mr', number: 17 }
    })
    expect(parseCmdJTaskSourceUrl('https://company.atlassian.net/browse/ORCA-123')).toEqual({
      provider: 'jira',
      parsed: {
        issueKey: 'ORCA-123',
        origin: 'https://company.atlassian.net',
        sitePath: ''
      }
    })
  })

  it('does not treat names or repo homepages as task URLs', () => {
    expect(parseCmdJTaskSourceUrl('sta-4052-agent-terminals')).toBeNull()
    expect(parseCmdJTaskSourceUrl('https://github.com/stablyai/orca')).toBeNull()
    expect(parseCmdJTaskSourceUrl('#14198')).toBeNull()
  })
})

describe('matchWorktreePaletteTaskUrl', () => {
  it('matches a GitHub issue URL to the linked worktree in the same repo', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/14198')
    expect(intent).not.toBeNull()

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedIssue: 14198 }),
        intent: intent!,
        repo: orcaRepo
      })
    ).toMatchObject({
      worktreeId: 'wt-1',
      matchedField: 'issue',
      supportingText: { labelKind: 'issue', text: 'Issue #14198' }
    })
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedIssue: 14198 }),
        intent: intent!,
        repo: { ...orcaRepo, displayName: 'other/repo' }
      })
    ).toBeNull()
  })

  it('matches a GitHub work-item number when the stored URL is missing', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'github',
            type: 'pr',
            number: 12789,
            title: 'Perf',
            url: ''
          }
        }),
        intent: intent!,
        repo: orcaRepo
      })
    ).toMatchObject({ matchedField: 'pr' })
  })

  it('matches a GitHub pull URL via the stored work-item URL', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'github',
            type: 'pr',
            number: 12789,
            title: 'Perf',
            url: 'https://github.com/stablyai/orca/pull/12789'
          }
        }),
        intent: intent!,
        repo: { ...orcaRepo, displayName: 'Repo 1' }
      })
    ).toMatchObject({ matchedField: 'pr', supportingText: { text: 'PR #12789' } })
  })

  it('matches a Linear issue URL and rejects a different organization', () => {
    const intent = parseCmdJTaskSourceUrl(
      'https://linear.app/stably/issue/STA-4052/agent-terminals-disappearing-randomly'
    )

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedLinearIssue: 'STA-4052',
          linkedLinearIssueOrganizationUrlKey: 'stably'
        }),
        intent: intent!
      })
    ).toMatchObject({ supportingText: { text: 'STA-4052' } })
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedLinearIssue: 'STA-4052',
          linkedLinearIssueOrganizationUrlKey: 'other'
        }),
        intent: intent!
      })
    ).toBeNull()
  })
})

describe('getCmdJTaskUrlCreatePreview', () => {
  it('describes GitHub issue and pull URLs without fetching', () => {
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/14198')!
      )
    ).toEqual({
      provider: 'github',
      identifier: '#14198',
      subtitle: 'stablyai/orca',
      kindLabel: 'GitHub issue',
      createLabel: 'Create worktree from GitHub issue stablyai/orca#14198'
    })
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')!
      )?.kindLabel
    ).toBe('GitHub pull request')
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')!
      )
    ).toMatchObject({
      provider: 'gitlab',
      identifier: '!17',
      kindLabel: 'GitLab merge request'
    })
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://company.atlassian.net/browse/ORCA-123')!
      )
    ).toMatchObject({
      provider: 'jira',
      identifier: 'ORCA-123',
      kindLabel: 'Jira issue'
    })
  })

  it('replaces the GitHub subtitle with the resolved issue title', () => {
    const preview = getCmdJTaskUrlCreatePreview(
      parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/14198')!
    )!
    expect(
      withResolvedCmdJGitHubPreview(preview, 'Agent terminals disappearing randomly', false)
    ).toEqual(
      expect.objectContaining({
        subtitle: 'Agent terminals disappearing randomly',
        createLabel:
          'Create worktree from GitHub issue stablyai/orca#14198: Agent terminals disappearing randomly',
        loading: false
      })
    )
    expect(withResolvedCmdJGitHubPreview(preview, null, true).loading).toBe(true)
  })
})
