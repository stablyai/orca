import { create } from 'zustand'
import { describe, expect, it } from 'vitest'
import {
  createTaskCreationDraftsSlice,
  isTaskCreationDraftContentful
} from './task-creation-drafts'
import type { AppState } from '../types'

function makeStore() {
  return create<
    Pick<
      AppState,
      | 'newLinearIssueDraft'
      | 'setNewLinearIssueDraft'
      | 'clearNewLinearIssueDraft'
      | 'newLinearProjectDraft'
      | 'setNewLinearProjectDraft'
      | 'clearNewLinearProjectDraft'
      | 'newJiraIssueDraft'
      | 'setNewJiraIssueDraft'
      | 'clearNewJiraIssueDraft'
    >
  >()((...args) =>
    createTaskCreationDraftsSlice(...(args as Parameters<typeof createTaskCreationDraftsSlice>))
  )
}

describe('createTaskCreationDraftsSlice', () => {
  it('starts with no drafts', () => {
    const state = makeStore().getState()
    expect(state.newLinearIssueDraft).toBeNull()
    expect(state.newLinearProjectDraft).toBeNull()
    expect(state.newJiraIssueDraft).toBeNull()
  })

  it('stores and clears each draft independently', () => {
    const store = makeStore()

    store.getState().setNewLinearIssueDraft({ title: 'Linear bug', body: 'details' })
    store.getState().setNewLinearProjectDraft({
      name: 'Roadmap',
      description: 'summary',
      content: 'brief'
    })
    store.getState().setNewJiraIssueDraft({ title: 'Jira bug', body: 'steps' })

    store.getState().clearNewLinearIssueDraft()

    expect(store.getState().newLinearIssueDraft).toBeNull()
    expect(store.getState().newLinearProjectDraft).toEqual({
      name: 'Roadmap',
      description: 'summary',
      content: 'brief'
    })
    expect(store.getState().newJiraIssueDraft).toEqual({ title: 'Jira bug', body: 'steps' })
  })

  it('replaces a draft wholesale on set', () => {
    const store = makeStore()
    store.getState().setNewJiraIssueDraft({ title: 'first', body: 'text' })

    store.getState().setNewJiraIssueDraft({ title: 'second', body: '' })

    expect(store.getState().newJiraIssueDraft).toEqual({ title: 'second', body: '' })
  })
})

describe('isTaskCreationDraftContentful', () => {
  it('rejects an all-empty or whitespace-only form', () => {
    expect(isTaskCreationDraftContentful({ title: '', body: '' })).toBe(false)
    expect(isTaskCreationDraftContentful({ title: '  ', body: '\n\t' })).toBe(false)
  })

  it('accepts any field with typed text', () => {
    expect(isTaskCreationDraftContentful({ title: 'Bug', body: '' })).toBe(true)
    expect(isTaskCreationDraftContentful({ name: '', description: '', content: 'brief' })).toBe(
      true
    )
  })
})
