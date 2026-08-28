import { describe, expect, it } from 'vitest'

import { resolveGitLabIssuePageState } from './gitlab-issue-pages'

const page = (itemCount: number, totalPages?: number) => ({
  items: Array.from({ length: itemCount }, (_, index) => index),
  totalPages
})

describe('resolveGitLabIssuePageState', () => {
  it('takes the widest pager across selected repos', () => {
    expect(
      resolveGitLabIssuePageState({
        requestedPage: 1,
        errorCount: 0,
        results: [page(50, 2), page(50, 7), page(10)]
      })
    ).toEqual({ page: 1, totalPages: 7 })
  })

  it('falls back to a single page when no repo reports a count', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 0, errorCount: 0, results: [page(3)] })
    ).toEqual({ page: 0, totalPages: 1 })
  })

  it('ignores a non-finite totalPages instead of poisoning the maximum', () => {
    expect(
      resolveGitLabIssuePageState({
        requestedPage: 0,
        errorCount: 0,
        results: [page(1, Number.NaN), page(1, 4)]
      })
    ).toEqual({ page: 0, totalPages: 4 })
  })

  it('lands directly on the last page the host reports instead of walking back', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 3, errorCount: 0, results: [page(0, 1)] })
    ).toEqual({ page: 0, totalPages: 1 })
  })

  it('steps back one page when the host still claims more pages than it can fill', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 3, errorCount: 0, results: [page(0, 5)] })
    ).toEqual({ page: 2, totalPages: 3 })
  })

  it('retreats when a speculative probe page comes back empty', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 2, errorCount: 0, results: [page(0)] })
    ).toEqual({ page: 1, totalPages: 2 })
  })

  it('keeps page 0 selected when the first page is genuinely empty', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 0, errorCount: 0, results: [page(0)] })
    ).toEqual({ page: 0, totalPages: 1 })
  })

  it('never sizes the pager below the page that just returned rows', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 3, errorCount: 0, results: [page(4, 2)] })
    ).toEqual({ page: 3, totalPages: 4 })
  })

  it('holds the requested page and pager size when every repo failed', () => {
    expect(resolveGitLabIssuePageState({ requestedPage: 2, errorCount: 1, results: [] })).toEqual({
      page: 2,
      totalPages: null
    })
  })

  it('still sizes the pager when some repos returned rows alongside an error', () => {
    expect(
      resolveGitLabIssuePageState({ requestedPage: 1, errorCount: 1, results: [page(4, 3)] })
    ).toEqual({ page: 1, totalPages: 3 })
  })
})
