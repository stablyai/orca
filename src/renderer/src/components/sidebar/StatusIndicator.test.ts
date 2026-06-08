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

function hasDot(status: Status): boolean {
  return /rounded-full/.test(renderMarkup(status))
}

describe('StatusIndicator', () => {
  it('renders working as a quiet neutral spinner — motion carries the signal, no loud color', () => {
    const classNames = renderDotClassNames('working')

    expect(classNames).toContain('border-muted-foreground')
    expect(classNames).toContain('border-t-transparent')
    expect(classNames).toContain('animate-spin')
  })

  it('renders permission as a warning attention dot', () => {
    const classNames = renderDotClassNames('permission')

    expect(classNames).toContain('bg-status-warning')
  })

  it.each<Status>(['done', 'active', 'inactive'])('renders no dot for %s', (status) => {
    expect(hasDot(status)).toBe(false)
  })

  it('always reserves the 3×3 lane so titles stay aligned even without a dot', () => {
    expect(renderMarkup('inactive')).toContain('h-3 w-3')
  })
})
