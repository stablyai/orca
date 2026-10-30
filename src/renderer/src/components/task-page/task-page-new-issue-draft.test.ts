import { describe, expect, it } from 'vitest'
import {
  resolveNewIssueOpenSeed,
  resolveVanishedNewIssueRepoReset
} from './task-page-new-issue-draft'
import type { NewIssueDraft } from '@/store/slices/new-issue-draft'
import type { GitHubAssignableUser } from '../../../../shared/github/pull-request-types'

const assignee: GitHubAssignableUser = { login: 'octocat', name: 'Octo', avatarUrl: '' }

function draft(overrides: Partial<NewIssueDraft> = {}): NewIssueDraft {
  return { title: '', body: '', labels: [], assignees: [], repoId: null, ...overrides }
}

describe('resolveNewIssueOpenSeed', () => {
  it('drops repo-scoped labels/assignees and falls back when the draft repo vanished', () => {
    expect(
      resolveNewIssueOpenSeed({
        draft: draft({
          title: 'Bug',
          body: 'details',
          labels: ['p1'],
          assignees: [assignee],
          repoId: 'removed-repo'
        }),
        selectedRepoIds: ['repo-a', 'repo-b']
      })
    ).toEqual({
      title: 'Bug',
      body: 'details',
      labels: [],
      assignees: [],
      repoId: 'repo-a'
    })
  })
})

describe('store-retention P1 guard (restore of an in-selection non-fallback repo)', () => {
  it('never routes a valid restore through a scoped-field clear, so nothing empty is mirrored back', () => {
    // Compose restore and vanish guards: clearing valid repo-scoped fields would persistently overwrite the recovery draft.
    const original = draft({
      title: 'Bug',
      body: 'details',
      labels: ['p1', 'regression'],
      assignees: [assignee],
      repoId: 'repo-b'
    })
    const selectedRepoIds = ['repo-a', 'repo-b']

    const seed = resolveNewIssueOpenSeed({ draft: original, selectedRepoIds })

    expect(seed.repoId).toBe('repo-b')
    expect(seed.repoId).not.toBe(selectedRepoIds[0])
    expect(seed.labels).toEqual(['p1', 'regression'])
    expect(seed.assignees).toEqual([assignee])

    expect(resolveVanishedNewIssueRepoReset(seed.repoId, selectedRepoIds)).toBeNull()

    expect(seed.labels.length).toBeGreaterThan(0)
    expect(seed.assignees.length).toBeGreaterThan(0)
    expect(seed.labels).toEqual(original.labels)
    expect(seed.assignees).toEqual(original.assignees)
  })
})
