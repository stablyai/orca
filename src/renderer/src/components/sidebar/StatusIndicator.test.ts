import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

function renderMarkup(status: Status): string {
  return renderToStaticMarkup(React.createElement(StatusIndicator, { status }))
}

function renderDotClassNames(status: Status): string[] {
  const markup = renderMarkup(status)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator', () => {
  it('renders active as full emerald dot', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-emerald-500')
  })

  it('renders done as an emerald check icon, not a dot', () => {
    const markup = renderMarkup('done')

    // Why: 'done' uses a CircleCheck icon rather than a rounded-full dot
    // so it is visually distinct from 'active' (also emerald). The assertion
    // targets the lucide 'circle-check' class hook + emerald text color,
    // which together identify the check icon without coupling to the exact
    // SVG path markup lucide emits.
    expect(markup).toContain('lucide-circle-check')
    expect(markup).toContain('text-emerald-500')
    expect(markup).not.toMatch(/<span class="[^"]*rounded-full[^"]*bg-emerald-500/)
  })
})
