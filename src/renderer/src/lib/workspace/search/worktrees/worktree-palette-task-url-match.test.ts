import { describe, expect, it } from 'vitest'

import type { Worktree } from '../../../../../../shared/worktree/types'
import {
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

describe('matchWorktreePaletteTaskUrl', () => {
  // Jira issue keys repeat across tenants sharing a project key.
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
})
