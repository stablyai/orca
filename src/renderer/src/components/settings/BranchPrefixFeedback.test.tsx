import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BranchPrefixFeedback } from './BranchPrefixFeedback'

function render(rawPrefix: string): string {
  return renderToStaticMarkup(React.createElement(BranchPrefixFeedback, { rawPrefix }))
}

describe('BranchPrefixFeedback', () => {
  it('previews the resulting branch name and drops a redundant trailing slash', () => {
    const html = render('team/')
    expect(html).toContain('team/feature')
    expect(html).not.toContain('team//feature')
    expect(html).toContain('text-muted-foreground')
  })

  it('warns when the prefix contains invalid characters', () => {
    const html = render('team x')
    expect(html).toContain('Prefix cannot contain spaces')
    expect(html).toContain('text-destructive')
  })

  it('reports when a slashes-only prefix collapses to no prefix', () => {
    const html = render('///')
    expect(html).toContain('No prefix will be applied')
  })

  it('renders no message for an empty prefix', () => {
    const html = render('')
    expect(html).not.toContain('feature')
    expect(html).not.toContain('Prefix cannot contain spaces')
    expect(html).not.toContain('No prefix will be applied')
  })
})
