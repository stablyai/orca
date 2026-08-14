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
  it('renders working as a yellow spinner ring', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('border-t-transparent')
    // Why: rotation must come from the compositor-driven CSS animation, not a
    // JS clock writing per-element styles on the input thread (STA-3328).
    expect(markup).toContain('agent-working-spinner')
    expect(markup).toContain('data-agent-spinner')
    // Why: under reduced motion the top border is filled so the static ring
    // reads as a complete marker, not a broken partial spinner (#9515).
    expect(markup).toContain('motion-reduce:border-t-yellow-500')
  })

  it('renders permission as the shared question glyph', () => {
    const markup = renderMarkup('permission')

    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('data-agent-spinner')
  })

  it('renders active as full emerald dot', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-emerald-500')
  })

  it('renders done as an emerald dot', () => {
    const classNames = renderDotClassNames('done')

    expect(classNames).toContain('bg-emerald-500')
  })
})
