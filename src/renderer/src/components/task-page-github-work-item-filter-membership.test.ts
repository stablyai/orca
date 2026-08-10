import { describe, expect, it } from 'vitest'
import type { ParsedTaskQuery } from '../../../shared/task-query'
import {
  recomputeTaskPageGitHubItemSoftHide,
  shouldSoftHideTaskPageGitHubWorkItem
} from './task-page-github-work-item-filter-membership'

const baseQuery = (overrides: Partial<ParsedTaskQuery> = {}): ParsedTaskQuery => ({
  scope: 'all',
  state: null,
  draft: false,
  assignee: null,
  author: null,
  reviewRequested: null,
  reviewedBy: null,
  labels: [],
  freeText: '',
  ...overrides
})

describe('shouldSoftHideTaskPageGitHubWorkItem', () => {
  it('hides closed or merged under is:open', () => {
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'closed', assignees: [], reviewRequests: [] },
        query: baseQuery({ state: 'open' }),
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'merged', assignees: [], reviewRequests: [] },
        query: baseQuery({ state: 'open' }),
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
  })

  it('does not state-soft-hide when state is null', () => {
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'closed', assignees: [], reviewRequests: [] },
        query: baseQuery({ state: null }),
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(false)
  })

  it('AND: hides on close or unassign under is:open assignee:@me', () => {
    const query = baseQuery({ state: 'open', assignee: '@me' })
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: {
          state: 'closed',
          assignees: [{ login: 'me', name: null, avatarUrl: '' }],
          reviewRequests: []
        },
        query,
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'open', assignees: [], reviewRequests: [] },
        query,
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
  })

  it('skips @me when skipMeQualifiers or viewerLogin null', () => {
    const query = baseQuery({ assignee: '@me' })
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'open', assignees: [], reviewRequests: [] },
        query,
        viewerLogin: null,
        skipMeQualifiers: false
      })
    ).toBe(false)
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'open', assignees: [], reviewRequests: [] },
        query,
        viewerLogin: 'me',
        skipMeQualifiers: true
      })
    ).toBe(false)
  })

  it('hides when concrete assignee login missing', () => {
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: {
          state: 'open',
          assignees: [{ login: 'bob', name: null, avatarUrl: '' }],
          reviewRequests: []
        },
        query: baseQuery({ assignee: 'alice' }),
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
  })

  it('hides non-draft items under is:draft', () => {
    const query = baseQuery({ scope: 'pr', state: 'open', draft: true })
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'open', assignees: [], reviewRequests: [] },
        query,
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'draft', assignees: [], reviewRequests: [] },
        query,
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(false)
  })

  it('hides when review-requested @me is missing', () => {
    expect(
      shouldSoftHideTaskPageGitHubWorkItem({
        item: { state: 'open', assignees: [], reviewRequests: [] },
        query: baseQuery({ reviewRequested: '@me' }),
        viewerLogin: 'me',
        skipMeQualifiers: false
      })
    ).toBe(true)
  })
})

describe('recomputeTaskPageGitHubItemSoftHide', () => {
  it('includes sticky hide for matching queryKey', () => {
    const itemKey = 'repo\0item'
    const result = recomputeTaskPageGitHubItemSoftHide({
      item: {
        state: 'open',
        assignees: [{ login: 'me', name: null, avatarUrl: '' }],
        reviewRequests: []
      },
      query: baseQuery({ state: 'open' }),
      viewerLogin: 'me',
      skipMeQualifiers: false,
      queryKey: 'q1',
      sticky: new Map([
        [
          itemKey,
          { itemKey, sourceScope: null, queryKey: 'q1', reason: 'filter_membership' as const }
        ]
      ]),
      itemKey
    })
    expect(result.hide).toBe(true)
    expect(result.sticky).toBe(true)
  })
})
