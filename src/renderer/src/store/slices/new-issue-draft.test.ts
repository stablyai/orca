import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import { createNewIssueDraftSlice } from './new-issue-draft'
import type { AppState } from '../types'
import type { GitHubAssignableUser } from '../../../../shared/types'

function makeStore() {
  return create<Pick<AppState, 'newIssueDraft' | 'setNewIssueDraft' | 'clearNewIssueDraft'>>()(
    (...args) => createNewIssueDraftSlice(...(args as Parameters<typeof createNewIssueDraftSlice>))
  )
}

const assignee: GitHubAssignableUser = { login: 'octocat', name: 'Octo', avatarUrl: '' }

describe('createNewIssueDraftSlice', () => {
  it('starts with no draft', () => {
    expect(makeStore().getState().newIssueDraft).toBeNull()
  })

  it('seeds a fresh empty draft with the patch when none exists', () => {
    const store = makeStore()

    store.getState().setNewIssueDraft({ title: 'Bug' })

    expect(store.getState().newIssueDraft).toEqual({
      title: 'Bug',
      body: '',
      labels: [],
      assignees: [],
      repoId: null
    })
  })

  it('shallow-merges the patch into the current draft', () => {
    const store = makeStore()
    store.getState().setNewIssueDraft({
      title: 'Bug',
      body: 'details',
      labels: ['p1'],
      assignees: [assignee],
      repoId: 'repo-a'
    })

    store.getState().setNewIssueDraft({ body: 'more details' })

    expect(store.getState().newIssueDraft).toEqual({
      title: 'Bug',
      body: 'more details',
      labels: ['p1'],
      assignees: [assignee],
      repoId: 'repo-a'
    })
  })

  it('clears the draft back to null', () => {
    const store = makeStore()
    store.getState().setNewIssueDraft({ title: 'Bug', repoId: 'repo-a' })

    store.getState().clearNewIssueDraft()

    expect(store.getState().newIssueDraft).toBeNull()
  })

  it('seeds fresh label/assignee arrays per empty draft (no shared-constant aliasing)', () => {
    // Regression: a module-level empty-draft constant would make partial patches
    // that omit labels/assignees alias one shared array instance, so an in-place
    // mutation of one draft would corrupt every subsequently-seeded empty draft.
    const a = makeStore()
    const b = makeStore()
    a.getState().setNewIssueDraft({ title: 'A' })
    b.getState().setNewIssueDraft({ title: 'B' })

    expect(a.getState().newIssueDraft?.labels).not.toBe(b.getState().newIssueDraft?.labels)
    expect(a.getState().newIssueDraft?.assignees).not.toBe(b.getState().newIssueDraft?.assignees)

    a.getState().newIssueDraft?.labels.push('leak')
    const c = makeStore()
    c.getState().setNewIssueDraft({ title: 'C' })
    expect(c.getState().newIssueDraft?.labels).toEqual([])
  })
})
