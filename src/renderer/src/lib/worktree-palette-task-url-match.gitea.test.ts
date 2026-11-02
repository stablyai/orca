import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import {
  getCmdJTaskUrlCreatePreview,
  matchWorktreePaletteTaskUrl,
  parseCmdJTaskSourceUrl
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

function giteaRepo(canonicalKey: string): Repo {
  return {
    id: 'repo-1',
    path: '/repo/orca',
    displayName: 'orca',
    badgeColor: '#22c55e',
    addedAt: 0,
    gitRemoteIdentity: {
      canonicalKey,
      remoteName: 'origin',
      remoteUrl: `https://${canonicalKey}.git`
    }
  }
}

describe('Gitea task URLs', () => {
  it('parses Gitea pull URLs on any host and issue URLs on known Gitea hosts', () => {
    expect(parseCmdJTaskSourceUrl('https://git.example.com/acme/orca/pulls/31')).toEqual({
      provider: 'gitea',
      link: { slug: { host: 'git.example.com', path: 'acme/orca' }, type: 'pr', number: 31 }
    })
    expect(parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/issues/8')).toEqual({
      provider: 'gitea',
      link: { slug: { host: 'codeberg.org', path: 'acme/orca' }, type: 'issue', number: 8 }
    })
  })

  it('leaves GitHub-shaped issue URLs on unknown hosts to GitHub', () => {
    expect(parseCmdJTaskSourceUrl('https://github.com/acme/orca/issues/8')).toMatchObject({
      provider: 'github'
    })
    expect(parseCmdJTaskSourceUrl('https://git.example.com/acme/orca/issues/8')).toMatchObject({
      provider: 'github'
    })
  })

  it('previews a Gitea pull request and issue', () => {
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/pulls/31')!
      )
    ).toMatchObject({
      provider: 'gitea',
      identifier: '#31',
      subtitle: 'codeberg.org/acme/orca',
      kindLabel: 'Gitea pull request'
    })
    expect(
      getCmdJTaskUrlCreatePreview(
        parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/issues/8')!
      )
    ).toMatchObject({ provider: 'gitea', kindLabel: 'Gitea issue' })
  })

  it('matches a workspace with the same Gitea attachment URL', () => {
    const intent = parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/pulls/31')!
    const match = matchWorktreePaletteTaskUrl({
      worktree: makeWorktree({
        linkedGiteaPR: 31,
        linkedItems: [
          {
            provider: 'gitea',
            type: 'pr',
            number: 31,
            url: 'https://codeberg.org/acme/orca/pulls/31'
          }
        ]
      }),
      intent,
      repo: giteaRepo('codeberg.org/acme/orca')
    })
    expect(match).not.toBeNull()
  })

  it('rejects the same number from a different Gitea project', () => {
    const intent = parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/pulls/31')!
    expect(
      matchWorktreePaletteTaskUrl({
        worktree: makeWorktree({
          linkedItems: [
            {
              provider: 'gitea',
              type: 'pr',
              number: 31,
              url: 'https://codeberg.org/other/project/pulls/31'
            }
          ]
        }),
        intent
      })
    ).toBeNull()
  })

  it('matches a bare-number attachment only when the repo remote is not a different project', () => {
    const intent = parseCmdJTaskSourceUrl('https://codeberg.org/acme/orca/issues/8')!
    const worktree = makeWorktree({
      linkedItems: [{ provider: 'gitea', type: 'issue', number: 8 }]
    })
    expect(
      matchWorktreePaletteTaskUrl({
        worktree,
        intent,
        repo: giteaRepo('codeberg.org/acme/orca')
      })
    ).not.toBeNull()
    expect(
      matchWorktreePaletteTaskUrl({
        worktree,
        intent,
        repo: giteaRepo('codeberg.org/other/project')
      })
    ).toBeNull()
  })
})
