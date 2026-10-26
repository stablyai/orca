import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/new-workspace', () => import('./linked-work-item-provider'))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { gitLabIssueNumber } from './launch-work-item-direct-messages'

describe('gitLabIssueNumber', () => {
  it('preserves GitLab issue numbers and rejects other work items', () => {
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: 0,
        url: 'https://gitlab.example/acme/project/-/issues/0'
      })
    ).toBe(0)
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: 7,
        url: 'https://gitlab.com/acme/project/-/work_items/7'
      })
    ).toBe(7)
    expect(
      gitLabIssueNumber({
        type: 'mr',
        number: 7,
        url: 'https://gitlab.example/acme/project/-/issues/7'
      })
    ).toBeUndefined()
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: 7,
        url: 'https://github.com/acme/project/issues/7'
      })
    ).toBeUndefined()
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: 7,
        url: 'https://gitlab.example/acme/project/-/merge_requests/7'
      })
    ).toBeUndefined()
    expect(
      gitLabIssueNumber({
        type: 'issue',
        url: 'https://gitlab.example/acme/project/-/issues/7'
      })
    ).toBeUndefined()
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: null,
        url: 'https://gitlab.example/acme/project/-/issues/7'
      })
    ).toBeUndefined()
    expect(gitLabIssueNumber({ type: 'issue', number: 7 })).toBeUndefined()
  })
})
