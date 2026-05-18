import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { HostedReviewHeaderLink } from './SourceControl'

function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 2192,
    title: 'Open PR in checks',
    state: 'open',
    url: 'https://github.com/stablyai/orca/pull/2192',
    status: 'pending',
    updatedAt: '2026-05-17T00:00:00Z',
    mergeable: 'UNKNOWN',
    ...overrides
  }
}

type MinimalClickEvent = Pick<React.MouseEvent, 'stopPropagation'>

describe('HostedReviewHeaderLink', () => {
  it('opens GitHub PRs in the Checks tab instead of rendering an external link', () => {
    const onOpenGitHubPRInChecks = vi.fn()
    const element = HostedReviewHeaderLink({
      review: makeReview(),
      onOpenGitHubPRInChecks
    })
    const markup = renderToStaticMarkup(element)

    expect(markup).toContain('<button')
    expect(markup).toContain('PR #2192')
    expect(markup).not.toContain('href=')
    expect(markup).not.toContain('target="_blank"')

    const stopPropagation = vi.fn()
    ;(element.props.onClick as (event: MinimalClickEvent) => void)({ stopPropagation })
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(onOpenGitHubPRInChecks).toHaveBeenCalledTimes(1)
  })

  it('keeps non-GitHub reviews as external hosted-review links', () => {
    const markup = renderToStaticMarkup(
      <HostedReviewHeaderLink
        review={makeReview({
          provider: 'gitlab',
          number: 31,
          url: 'https://gitlab.com/acme/widgets/-/merge_requests/31'
        })}
        onOpenGitHubPRInChecks={vi.fn()}
      />
    )

    expect(markup).toContain('<a')
    expect(markup).toContain('href="https://gitlab.com/acme/widgets/-/merge_requests/31"')
    expect(markup).toContain('target="_blank"')
    expect(markup).toContain('MR #31')
  })
})
