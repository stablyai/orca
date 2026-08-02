import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/new-workspace', () => ({
  isGitLabIssueUrl: (url: string) => url.includes('gitlab.example')
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

import { gitLabIssueNumber } from './launch-work-item-direct-messages'

describe('gitLabIssueNumber', () => {
  it('preserves zero-valued issue numbers when the URL is a GitLab issue URL', () => {
    expect(
      gitLabIssueNumber({
        type: 'issue',
        number: 0,
        url: 'https://gitlab.example/acme/project/-/issues/0'
      })
    ).toBe(0)
  })
})
