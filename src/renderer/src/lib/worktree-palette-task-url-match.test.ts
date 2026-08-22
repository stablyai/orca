import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
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

function gitLabRepo(canonicalKey: string): Repo {
  return {
    ...orcaRepo,
    displayName: 'orca',
    gitRemoteIdentity: {
      canonicalKey,
      remoteName: 'origin',
      remoteUrl: `git@${canonicalKey.replace('/', ':')}.git`
    }
  }
}

/** Basename displayName: the common non-fork case, where only the remote identifies the repo. */
function gitHubRepo(canonicalKey: string): Repo {
  return {
    ...orcaRepo,
    displayName: 'orca',
    gitRemoteIdentity: {
      canonicalKey,
      remoteName: 'origin',
      remoteUrl: `git@${canonicalKey.replace('/', ':')}.git`
    }
  }
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
  it('retains the matched workspace host for host-qualified consumers', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/123')
    expect(intent).not.toBeNull()

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          hostId: 'ssh:box',
          linkedWorkItem: {
            provider: 'github',
            type: 'issue',
            number: 123,
            title: 'Host-qualified match',
            url: 'https://github.com/stablyai/orca/issues/123'
          }
        }),
        intent: intent!
      })
    ).toMatchObject({ worktreeId: 'wt-1', worktreeHostId: 'ssh:box' })
  })

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
      matchedFields: ['issue'],
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
    ).toMatchObject({ matchedFields: ['pr'] })
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
    ).toMatchObject({ matchedFields: ['pr'], supportingText: { text: 'PR #12789' } })
  })

  it('gates a stored GitHub number on the repo remote identity', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('github.com/other/project')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toMatchObject({ matchedFields: ['pr'], supportingText: { text: 'PR #12789' } })
  })

  it('gates a stored GitHub work item with no URL on the repo remote identity', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/14198')
    const worktree = makeWorktree({
      linkedWorkItem: { provider: 'github', type: 'issue', number: 14198, title: 'Bug', url: '' }
    })
    expect(
      matchWorktreePaletteTaskUrl({
        worktree,
        intent: intent!,
        repo: gitHubRepo('github.com/other/project')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree,
        intent: intent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toMatchObject({ matchedFields: ['issue'] })
  })

  it('does not match a GitHub URL on a different host for the same owner/repo', () => {
    const intent = parseCmdJTaskSourceUrl('https://ghe.example.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('ghe.example.com/stablyai/orca')
      })
    ).toMatchObject({ matchedFields: ['pr'] })
  })

  it('matches GitHub remotes whose host is an SSH alias or www form of github.com', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    for (const canonicalKey of [
      // ssh://git@ssh.github.com:443/... — GitHub's port-443 workaround.
      'ssh.github.com/stablyai/orca',
      // git@github-work:... — an OpenSSH `Host` alias `git remote -v` cannot expand.
      'github-work/stablyai/orca',
      'www.github.com/stablyai/orca'
    ]) {
      expect(
        matchWorktreePaletteTaskUrl({
          worktree: makeWorktree({ linkedPR: 12789 }),
          intent: intent!,
          repo: gitHubRepo(canonicalKey)
        })
      ).toMatchObject({ matchedFields: ['pr'] })
    }
    // A real, resolvable host is evidence of a different forge, not an alias.
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('ghe.example.com/stablyai/orca')
      })
    ).toBeNull()
  })

  it('normalizes host case, port, and owner case before comparing GitHub identities', () => {
    const intent = parseCmdJTaskSourceUrl('https://GHE.Example.com:8443/StablyAI/Orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('ghe.example.com/stablyai/orca')
      })
    ).toMatchObject({ matchedFields: ['pr'] })
  })

  it('stays permissive for GitHub numbers when the repo remote identity is unknown', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: { ...orcaRepo, displayName: 'orca' }
      })
    ).toMatchObject({ matchedFields: ['pr'] })
    expect(
      matchWorktreePaletteTaskUrl({ worktree: makeWorktree({ linkedPR: 12789 }), intent: intent! })
    ).toMatchObject({ matchedFields: ['pr'] })
  })

  it('stays permissive for a GitHub fork whose identity resolved to the upstream remote', () => {
    // `deriveGitRemoteIdentity` prefers `upstream`, so the fork's own `origin` is not visible here.
    const forkRepo: Repo = {
      ...gitHubRepo('github.com/stablyai/orca'),
      gitRemoteIdentity: {
        canonicalKey: 'github.com/stablyai/orca',
        remoteName: 'upstream',
        remoteUrl: 'git@github.com:stablyai/orca.git'
      }
    }
    const intent = parseCmdJTaskSourceUrl('https://github.com/me/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: forkRepo
      })
    ).toMatchObject({ matchedFields: ['pr'] })
    // An `origin`-derived identity is authoritative, so a different repo still loses.
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toBeNull()
  })

  it('keeps the GitHub number gate type-aware across repos', () => {
    const prIntent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    const issueIntent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/issues/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedIssue: 12789 }),
        intent: prIntent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedIssue: 12789 }),
        intent: issueIntent!,
        repo: gitHubRepo('github.com/other/project')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedIssue: 12789 }),
        intent: issueIntent!,
        repo: gitHubRepo('github.com/stablyai/orca')
      })
    ).toMatchObject({ matchedFields: ['issue'], supportingText: { text: 'Issue #12789' } })
  })

  it('keeps an owner/repo displayName authoritative over a host-alias remote', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedPR: 12789 }),
        intent: intent!,
        repo: {
          ...orcaRepo,
          gitRemoteIdentity: {
            canonicalKey: 'git-mirror.example.com/stablyai/orca',
            remoteName: 'origin',
            remoteUrl: 'git@git-mirror.example.com:stablyai/orca.git'
          }
        }
      })
    ).toMatchObject({ matchedFields: ['pr'] })
  })

  it('matches a GitHub PR URL via the linked review URL regardless of remote identity', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/stablyai/orca/pull/12789')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree(),
        intent: intent!,
        repo: gitHubRepo('github.com/other/project'),
        review: {
          provider: 'github',
          number: 12789,
          title: 'Fork PR',
          state: 'open',
          url: 'https://github.com/stablyai/orca/pull/12789',
          status: 'pending',
          updatedAt: '2026-01-01T00:00:00Z',
          mergeable: 'UNKNOWN'
        }
      })
    ).toMatchObject({ matchedFields: ['pr'] })
  })

  it('rejects a GitLab MR URL from a different project than the stored URL', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedGitLabMR: 17,
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'mr',
            number: 17,
            title: 'Other project MR',
            url: 'https://gitlab.example.com/other/project/-/merge_requests/17'
          }
        }),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/other/project')
      })
    ).toBeNull()
  })

  it('matches a GitLab MR URL for the same project', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedGitLabMR: 17,
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'mr',
            number: 17,
            title: 'Same project MR',
            url: 'https://gitlab.com/acme/orca/-/merge_requests/17'
          }
        }),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/other/project')
      })
    ).toMatchObject({
      matchedFields: ['mr'],
      supportingText: { labelKind: 'mr', text: 'MR #17' }
    })
  })

  it('does not match a GitLab issue URL against a stored MR of the same number', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedGitLabIssue: 17,
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'issue',
            number: 17,
            title: 'Issue',
            url: 'https://gitlab.com/acme/orca/-/issues/17'
          }
        }),
        intent: intent!
      })
    ).toBeNull()
  })

  it('does not match a GitLab URL on a different host for the same project path', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedGitLabMR: 17,
          linkedWorkItem: {
            provider: 'gitlab',
            type: 'mr',
            number: 17,
            title: 'Self-hosted MR',
            url: 'https://gitlab.example.com/acme/orca/-/merge_requests/17'
          }
        }),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/acme/orca')
      })
    ).toBeNull()
  })

  it('gates a stored GitLab number with no work item on the repo remote identity', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/other/project')
      })
    ).toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: intent!,
        repo: gitLabRepo('gitlab.com/acme/orca')
      })
    ).toMatchObject({ matchedFields: ['mr'] })
  })

  it('matches GitLab remotes whose host is an SSH alias or www form of gitlab.com', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    for (const canonicalKey of [
      // altssh.gitlab.com is GitLab's port-443 SSH endpoint; `gitlab-work` is an ssh-config alias.
      'altssh.gitlab.com/acme/orca',
      'gitlab-work/acme/orca',
      'www.gitlab.com/acme/orca'
    ]) {
      expect(
        matchWorktreePaletteTaskUrl({
          worktree: makeWorktree({ linkedGitLabMR: 17 }),
          intent: intent!,
          repo: gitLabRepo(canonicalKey)
        })
      ).toMatchObject({ matchedFields: ['mr'] })
    }
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/acme/orca')
      })
    ).toBeNull()
  })

  it('stays permissive for GitLab numbers when the repo remote identity is unknown', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: intent!,
        repo: orcaRepo
      })
    ).toMatchObject({ matchedFields: ['mr'] })
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: intent!
      })
    ).toMatchObject({ matchedFields: ['mr'] })
  })

  it('declines a different GitLab project even when the identity came from upstream', () => {
    // STA-4450: iids are per-project, so a bare `linkedGitLabMR` must not span projects.
    // `deriveGitRemoteIdentity` prefers `upstream`, so the fork's own `origin` is not visible here;
    // an MR URL from the fork itself is the accepted false negative of gating on the known project.
    const forkRepo: Repo = {
      ...gitLabRepo('gitlab.com/acme/orca'),
      gitRemoteIdentity: {
        canonicalKey: 'gitlab.com/acme/orca',
        remoteName: 'upstream',
        remoteUrl: 'git@gitlab.com:acme/orca.git'
      }
    }
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: parseCmdJTaskSourceUrl('https://gitlab.com/me/orca/-/merge_requests/17')!,
        repo: forkRepo
      })
    ).toBeNull()
    // The project the identity does name still matches.
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')!,
        repo: forkRepo
      })
    ).toMatchObject({ matchedFields: ['mr'] })
    // An `origin`-derived identity is authoritative, so a different project still loses.
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({ linkedGitLabMR: 17 }),
        intent: parseCmdJTaskSourceUrl('https://gitlab.com/me/orca/-/merge_requests/17')!,
        repo: gitLabRepo('gitlab.com/acme/orca')
      })
    ).toBeNull()
  })

  it('matches both GitLab issue URL forms and rejects other projects', () => {
    for (const url of [
      'https://gitlab.com/acme/orca/-/issues/17',
      'https://gitlab.com/acme/orca/-/work_items/17'
    ]) {
      const intent = parseCmdJTaskSourceUrl(url)
      expect(intent).toMatchObject({ provider: 'gitlab', link: { type: 'issue', number: 17 } })
      expect(
        matchWorktreePaletteTaskUrl({
          worktree: makeWorktree({ linkedGitLabIssue: 17 }),
          intent: intent!,
          repo: gitLabRepo('gitlab.com/acme/orca')
        })
      ).toMatchObject({
        matchedFields: ['issue'],
        supportingText: { labelKind: 'issue', text: 'Issue #17' }
      })
      expect(
        matchWorktreePaletteTaskUrl({
          worktree: makeWorktree({ linkedGitLabIssue: 17 }),
          intent: intent!,
          repo: gitLabRepo('gitlab.example.com/other/project')
        })
      ).toBeNull()
    }
  })

  it('matches a GitLab MR URL via the linked review URL', () => {
    const intent = parseCmdJTaskSourceUrl('https://gitlab.com/acme/orca/-/merge_requests/17')
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree(),
        intent: intent!,
        repo: gitLabRepo('gitlab.example.com/other/project'),
        review: {
          provider: 'gitlab',
          number: 17,
          title: 'Fork MR',
          state: 'open',
          url: 'https://gitlab.com/acme/orca/-/merge_requests/17',
          status: 'pending',
          updatedAt: '2026-01-01T00:00:00Z',
          mergeable: 'UNKNOWN'
        }
      })
    ).toMatchObject({ matchedFields: ['mr'] })
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

  it('matches a Jira issue URL on its own tenant', () => {
    const intent = parseCmdJTaskSourceUrl('https://acme.atlassian.net/browse/PROJ-123')

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Tenant scoped',
            jiraIdentifier: 'PROJ-123',
            url: 'https://acme.atlassian.net/browse/PROJ-123'
          }
        }),
        intent: intent!
      })
    ).toMatchObject({ supportingText: { text: 'PROJ-123' } })
  })

  // Why: Jira issue keys are per-project, so the same PROJ-123 exists on every
  // tenant that has a PROJ project.
  it('rejects a Jira issue URL from a different tenant with the same issue key', () => {
    const intent = parseCmdJTaskSourceUrl('https://acme.atlassian.net/browse/PROJ-123')

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Other tenant',
            jiraIdentifier: 'PROJ-123',
            url: 'https://other.atlassian.net/browse/PROJ-123'
          }
        }),
        intent: intent!
      })
    ).toBeNull()
  })

  it('carries the worktree host so the board can key the Jira match by host identity', () => {
    // Why: the other three providers spread worktreeHostId and Jira did not, so a Jira URL
    // recorded an unqualified identity and the board filtered every lane to empty.
    const intent = parseCmdJTaskSourceUrl('https://acme.atlassian.net/browse/PROJ-123')

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          hostId: 'ssh:box',
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Ticket',
            jiraIdentifier: 'PROJ-123',
            url: 'https://acme.atlassian.net/browse/PROJ-123'
          }
        }),
        intent: intent!
      })
    ).toMatchObject({ worktreeHostId: 'ssh:box' })
  })

  // Same host, different site path: Jira Server installs are commonly path-scoped.
  it('rejects a Jira issue URL from a different site path on the same host', () => {
    const intent = parseCmdJTaskSourceUrl('https://jira.acme.test/one/browse/PROJ-123')

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Other site',
            jiraIdentifier: 'PROJ-123',
            url: 'https://jira.acme.test/two/browse/PROJ-123'
          }
        }),
        intent: intent!
      })
    ).toBeNull()
  })

  // The reachable fallback: `normalizeWorkspaceLinkedItem` drops any item with a
  // blank url, so the only way to have no tenant evidence is a url that is present
  // but is not a Jira browse link. The identifier is then all there is.
  it('falls back to the Jira identifier when the stored url is not a Jira link', () => {
    const intent = parseCmdJTaskSourceUrl('https://acme.atlassian.net/browse/PROJ-123')

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Linked elsewhere',
            jiraIdentifier: 'PROJ-123',
            url: 'https://github.com/stablyai/orca/issues/14198'
          }
        }),
        intent: intent!
      })
    ).toMatchObject({ supportingText: { text: 'PROJ-123' } })
  })

  // Jira appends a tracking query on copy, and the matcher is pathname-only.
  it('matches a pasted Jira url carrying a tracking query string', () => {
    const intent = parseCmdJTaskSourceUrl(
      'https://acme.atlassian.net/browse/PROJ-123?atlOrigin=eyJpIjoiZm9vIn0'
    )

    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedWorkItem: {
            provider: 'jira',
            type: 'issue',
            number: 0,
            title: 'Tenant scoped',
            jiraIdentifier: 'PROJ-123',
            url: 'https://acme.atlassian.net/browse/PROJ-123'
          }
        }),
        intent: intent!
      })
    ).toMatchObject({ supportingText: { text: 'PROJ-123' } })
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
