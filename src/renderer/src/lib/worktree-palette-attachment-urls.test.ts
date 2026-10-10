import { worktreeMatchesGitHubNumber } from './github-work-item-workspace-attachment'
import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../shared/worktree/types'
import {
  referenceWorkspace,
  referenceRepo
} from '@/components/sidebar/workspace-reference-fixtures.test-support'
import {
  matchWorktreePaletteTaskUrl,
  parseCmdJTaskSourceUrl
} from './worktree-palette-task-url-match'

describe('multiple workspace task attachments', () => {
  it.each([
    { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/acme/orca/pull/42' },
    {
      provider: 'gitlab',
      type: 'mr',
      number: 42,
      url: 'https://gitlab.com/team/orca/-/merge_requests/42'
    },
    {
      provider: 'linear',
      type: 'issue',
      number: 0,
      identifier: 'STA-42',
      url: 'https://linear.app/acme/issue/STA-42/title'
    },
    {
      provider: 'jira',
      type: 'issue',
      number: 0,
      identifier: 'STA-42',
      url: 'https://acme.atlassian.net/browse/STA-42'
    }
  ] as const)('matches secondary $provider links by their full URL', (attachment) => {
    const intent = parseCmdJTaskSourceUrl(attachment.url)
    if (!intent) {
      throw new Error('Fixture URL should parse')
    }
    const worktree = { ...referenceWorkspace, linkedPR: 1, linkedItems: [attachment] }
    expect(matchWorktreePaletteTaskUrl({ worktree, intent })).not.toBeNull()
  })
  it('does not match a same-number review in another repository', () => {
    const intent = parseCmdJTaskSourceUrl('https://github.com/other/project/pull/42')
    if (!intent) {
      throw new Error('Fixture URL should parse')
    }
    const worktree: Worktree = {
      ...referenceWorkspace,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/acme/orca/pull/42' }
      ]
    }
    expect(matchWorktreePaletteTaskUrl({ worktree, intent })).toBeNull()
  })
})

describe('bare GitHub number activation', () => {
  it.each([
    { repoId: 'foreign' },
    { url: 'https://github.com/foreign/project/pull/42' },
    { repoId: 'repo', url: 'https://github.com/foreign/project/issues/42' },
    { url: 'https://github.example.com/acme/orca/pull/42' }
  ])('rejects foreign references even without a repo id: %j', (scope) => {
    const worktree: Worktree = {
      ...referenceWorkspace,
      linkedItems: [{ provider: 'github', type: 'pr', number: 42, ...scope }]
    }
    expect(worktreeMatchesGitHubNumber(worktree, 42, referenceRepo)).toBe(false)
  })
  it('matches secondary local references and legacy bare numbers', () => {
    const worktree: Worktree = {
      ...referenceWorkspace,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 42, url: 'https://github.com/acme/orca/pull/42' }
      ]
    }
    expect(worktreeMatchesGitHubNumber(worktree, 42, referenceRepo)).toBe(true)
    expect(worktreeMatchesGitHubNumber(referenceWorkspace, 7, referenceRepo)).toBe(true)
    expect(worktreeMatchesGitHubNumber(worktree, 42, undefined)).toBe(false)
  })
})
