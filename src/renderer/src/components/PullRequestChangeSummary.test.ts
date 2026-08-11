import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PullRequestChangeSummary } from './PullRequestChangeSummary'

function renderSummary(props: {
  readonly additions?: number
  readonly deletions?: number
}): string {
  return renderToStaticMarkup(React.createElement(PullRequestChangeSummary, props))
}

describe('PullRequestChangeSummary', () => {
  it('renders added and deleted line totals with git decoration colors', () => {
    const markup = renderSummary({ additions: 128, deletions: 34 })

    expect(markup).toContain('128 lines added')
    expect(markup).toContain('34 lines deleted')
    expect(markup).toContain('var(--git-decoration-added)')
    expect(markup).toContain('var(--git-decoration-deleted)')
  })

  it('keeps explicit zero totals visible', () => {
    const markup = renderSummary({ additions: 0, deletions: 0 })

    expect(markup).toContain('0 lines added')
    expect(markup).toContain('0 lines deleted')
  })

  it('renders the available total when GitHub omits the other one', () => {
    const markup = renderSummary({ additions: 12 })

    expect(markup).toContain('+12')
    expect(markup).not.toContain('git-decoration-deleted')
  })

  it('renders nothing when GitHub provides no change totals', () => {
    expect(renderSummary({})).toBe('')
  })
})
