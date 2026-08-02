import { describe, expect, it } from 'vitest'
import {
  isNewIssueDraftContentful,
  resolveNewIssueOpenSeed,
  resolveUserRepoSwitchReset,
  resolveVanishedNewIssueRepoReset
} from './task-page-new-issue-draft'
import type { NewIssueDraft } from '@/store/slices/new-issue-draft'
import type { GitHubAssignableUser } from '../../../shared/types'

const assignee: GitHubAssignableUser = { login: 'octocat', name: 'Octo', avatarUrl: '' }

function draft(overrides: Partial<NewIssueDraft> = {}): NewIssueDraft {
  return { title: '', body: '', labels: [], assignees: [], repoId: null, ...overrides }
}

describe('isNewIssueDraftContentful', () => {
  it('is false for null and an all-empty draft', () => {
    expect(isNewIssueDraftContentful(null)).toBe(false)
    expect(isNewIssueDraftContentful(draft())).toBe(false)
  })

  it('is false for whitespace-only title/body', () => {
    expect(isNewIssueDraftContentful(draft({ title: '   ', body: '\n\t' }))).toBe(false)
  })

  it('is false when only a repoId is set (repoId is not content)', () => {
    expect(isNewIssueDraftContentful(draft({ repoId: 'repo-a' }))).toBe(false)
  })

  it('is true once a title, body, label, or assignee is present', () => {
    expect(isNewIssueDraftContentful(draft({ title: 'Bug' }))).toBe(true)
    expect(isNewIssueDraftContentful(draft({ body: 'details' }))).toBe(true)
    expect(isNewIssueDraftContentful(draft({ labels: ['p1'] }))).toBe(true)
    expect(isNewIssueDraftContentful(draft({ assignees: [assignee] }))).toBe(true)
  })
})

describe('resolveNewIssueOpenSeed', () => {
  it('takes the empty-default branch for no draft, targeting the first selected repo', () => {
    expect(resolveNewIssueOpenSeed({ draft: null, selectedRepoIds: ['repo-a', 'repo-b'] })).toEqual(
      { title: '', body: '', labels: [], assignees: [], repoId: 'repo-a' }
    )
  })

  it('takes the default branch for a draft carrying only a repoId', () => {
    expect(
      resolveNewIssueOpenSeed({
        draft: draft({ repoId: 'repo-b' }),
        selectedRepoIds: ['repo-a', 'repo-b']
      })
    ).toEqual({ title: '', body: '', labels: [], assignees: [], repoId: 'repo-a' })
  })

  it('restores every field when the draft repo is still selected', () => {
    expect(
      resolveNewIssueOpenSeed({
        draft: draft({
          title: 'Bug',
          body: 'details',
          labels: ['p1'],
          assignees: [assignee],
          repoId: 'repo-b'
        }),
        selectedRepoIds: ['repo-a', 'repo-b']
      })
    ).toEqual({
      title: 'Bug',
      body: 'details',
      labels: ['p1'],
      assignees: [assignee],
      repoId: 'repo-b'
    })
  })

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

  it('resolves repoId to null only when nothing is selected', () => {
    expect(
      resolveNewIssueOpenSeed({ draft: draft({ title: 'Bug' }), selectedRepoIds: [] })
    ).toEqual({ title: 'Bug', body: '', labels: [], assignees: [], repoId: null })
  })
})

describe('store-retention P1 guard (restore of an in-selection non-fallback repo)', () => {
  it('never routes a valid restore through a scoped-field clear, so nothing empty is mirrored back', () => {
    // P1 guard: a draft targeting a selected repo that is NOT selectedRepoIds[0]
    // (the multi-repo case) must restore its repo-scoped labels/assignees intact.
    // If restore instead emptied them, the write-through effect would mirror the
    // empty values back into the store and durably corrupt the recovery draft.
    // Compose the real helpers to prove restore never hits a clear path.
    const original = draft({
      title: 'Bug',
      body: 'details',
      labels: ['p1', 'regression'],
      assignees: [assignee],
      repoId: 'repo-b'
    })
    const selectedRepoIds = ['repo-a', 'repo-b']

    const seed = resolveNewIssueOpenSeed({ draft: original, selectedRepoIds })

    // Restore keeps the scoped fields and targets the draft's own repo...
    expect(seed.repoId).toBe('repo-b')
    expect(seed.repoId).not.toBe(selectedRepoIds[0])
    expect(seed.labels).toEqual(['p1', 'regression'])
    expect(seed.assignees).toEqual([assignee])

    // ...and the vanish-guard does NOT fire on the restored (in-selection) repo,
    // so no imperative clear runs either.
    expect(resolveVanishedNewIssueRepoReset(seed.repoId, selectedRepoIds)).toBeNull()

    // Therefore the fields the write-through would persist equal the original
    // draft's scoped fields — non-empty and unchanged (no corruption).
    expect(seed.labels.length).toBeGreaterThan(0)
    expect(seed.assignees.length).toBeGreaterThan(0)
    expect(seed.labels).toEqual(original.labels)
    expect(seed.assignees).toEqual(original.assignees)
  })
})

describe('resolveUserRepoSwitchReset', () => {
  it('clears both repo-scoped labels and assignees on a genuine user repo switch', () => {
    expect(resolveUserRepoSwitchReset()).toEqual({ labels: [], assignees: [] })
  })
})

describe('resolveVanishedNewIssueRepoReset', () => {
  it('returns null when the chosen repo is still selected', () => {
    expect(resolveVanishedNewIssueRepoReset('repo-b', ['repo-a', 'repo-b'])).toBeNull()
  })

  it('returns null when no repo is chosen', () => {
    expect(resolveVanishedNewIssueRepoReset(null, ['repo-a'])).toBeNull()
  })

  it('resets to the first selected repo when the chosen repo vanished', () => {
    expect(resolveVanishedNewIssueRepoReset('removed', ['repo-a', 'repo-b'])).toEqual({
      repoId: 'repo-a'
    })
  })

  it('resets to null when the chosen repo vanished and nothing remains selected', () => {
    expect(resolveVanishedNewIssueRepoReset('removed', [])).toEqual({ repoId: null })
  })
})
