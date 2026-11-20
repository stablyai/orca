import { describe, expect, it } from 'vitest'
import {
  AddIssueComment,
  AddPRComment,
  AddPRInlineComment,
  CreateIssue,
  EmptyParams,
  GiteaRateLimit,
  IssuesList,
  JobTrace,
  MergePr,
  RepoSelector,
  ResolvePRDiscussion,
  SubmitPRReview,
  UpdateIssue,
  UpdatePr,
  UpdatePrReviewers,
  UpdatePrState,
  WorkItemByPath,
  WorkItemDetails,
  WorkItemsList
} from './gitea-params'

const repo = { repo: 'id:repo-1' }

describe('gitea RPC parameter schemas', () => {
  it('rejects a missing repo selector and accepts an empty auth payload', () => {
    expect(RepoSelector.safeParse({}).success).toBe(false)
    expect(EmptyParams.parse(undefined)).toEqual({})
    expect(GiteaRateLimit.parse(undefined)).toEqual({})
    expect(GiteaRateLimit.parse({ force: true, host: 'gitea.example.com' })).toEqual({
      force: true,
      host: 'gitea.example.com'
    })
  })

  it('accepts paged work-item and issue lists', () => {
    expect(
      WorkItemsList.parse({ ...repo, state: 'opened', page: 2, perPage: 20, query: 'bug' })
    ).toMatchObject({ state: 'opened', page: 2, perPage: 20, query: 'bug' })
    expect(WorkItemsList.safeParse({ ...repo, state: 'draft' }).success).toBe(false)
    expect(
      IssuesList.parse({ ...repo, state: 'closed', assignee: 'ada', limit: 10, page: 1 })
    ).toMatchObject({ state: 'closed', assignee: 'ada', limit: 10, page: 1 })
  })

  it('requires issue create and comment bodies and open/closed issue updates', () => {
    expect(CreateIssue.safeParse({ ...repo, title: ' ', body: '' }).success).toBe(false)
    expect(CreateIssue.parse({ ...repo, title: 'Bug', body: '' })).toMatchObject({ title: 'Bug' })
    expect(AddIssueComment.safeParse({ ...repo, number: 4, body: ' ' }).success).toBe(false)
    expect(
      UpdateIssue.parse({
        ...repo,
        number: 4,
        updates: { state: 'open', addLabels: ['bug'] },
        projectRef: null
      }).updates.state
    ).toBe('open')
    expect(UpdateIssue.safeParse({ ...repo, number: 0, updates: {} }).success).toBe(false)
  })

  it('accepts pull-request mutations, reviews, and job traces', () => {
    expect(UpdatePrState.parse({ ...repo, number: 9, state: 'closed' }).state).toBe('closed')
    expect(
      MergePr.parse({ ...repo, number: 9, method: 'rebase-merge', projectRef: null }).method
    ).toBe('rebase-merge')
    expect(MergePr.safeParse({ ...repo, number: 9, method: 'fast-forward' }).success).toBe(false)
    expect(
      UpdatePr.parse({
        ...repo,
        number: 9,
        updates: { title: 'Ready', draft: false },
        projectRef: { host: 'gitea.example.com', path: 'team/repo' }
      }).updates.draft
    ).toBe(false)
    expect(
      UpdatePrReviewers.parse({ ...repo, number: 9, reviewerUsernames: ['ada'] }).reviewerUsernames
    ).toEqual(['ada'])
    expect(AddPRComment.safeParse({ ...repo, number: 9, body: '' }).success).toBe(false)
    expect(
      AddPRInlineComment.parse({
        ...repo,
        number: 9,
        input: { body: 'nit', path: 'a.ts', line: 3, headSha: 'abc' }
      }).input.path
    ).toBe('a.ts')
    expect(
      AddPRInlineComment.safeParse({
        ...repo,
        number: 9,
        input: { body: 'nit', path: 'a.ts', line: 0, headSha: 'abc' }
      }).success
    ).toBe(false)
    expect(
      ResolvePRDiscussion.parse({ ...repo, number: 9, discussionId: '15', resolved: true }).resolved
    ).toBe(true)
    expect(
      SubmitPRReview.parse({ ...repo, number: 9, decision: 'request_changes', body: 'fix' })
        .decision
    ).toBe('request_changes')
    expect(SubmitPRReview.safeParse({ ...repo, number: 9, decision: 'comment' }).success).toBe(
      false
    )
    expect(JobTrace.parse({ ...repo, jobId: 4, logExcerpt: true }).jobId).toBe(4)
    expect(
      WorkItemDetails.parse({
        ...repo,
        number: 9,
        type: 'pr',
        includeReviewDetails: true,
        projectRef: null
      }).type
    ).toBe('pr')
    expect(
      WorkItemByPath.parse({
        ...repo,
        host: 'gitea.example.com',
        path: 'team/repo',
        number: 9,
        type: 'issue'
      }).path
    ).toBe('team/repo')
  })
})
