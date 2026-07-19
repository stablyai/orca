import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

function renderMarkup(status: Status): string {
  return renderToStaticMarkup(React.createElement(StatusIndicator, { status, showTooltip: false }))
}

function renderDotClassNames(status: Status): string[] {
  const markup = renderMarkup(status)
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator', () => {
  it('exposes a labeled image role when it owns the accessible status', () => {
    const markup = renderMarkup('working')

    expect(markup).toContain('role="img"')
    expect(markup).toContain('aria-label="Working"')
  })

  it('renders working as a stepped yellow spinner', () => {
    const classNames = renderDotClassNames('working')

    expect(classNames).toContain('border-status-working')
    expect(classNames).toContain('border-t-transparent')
    expect(classNames).toContain('[animation:spin_1s_steps(12,end)_infinite]')
    expect(classNames).toContain('motion-reduce:animate-none')
    expect(classNames).not.toContain('animate-spin')
  })

  it('renders permission as an amber attention dot', () => {
    const classNames = renderDotClassNames('permission')

    expect(classNames).toContain('bg-status-attention')
    expect(classNames).not.toContain('bg-destructive')
  })

  it('renders blocked as a destructive dot', () => {
    const classNames = renderDotClassNames('blocked')

    expect(classNames).toContain('bg-destructive')
    expect(classNames).not.toContain('bg-status-attention')
  })

  it('renders interrupted as a labeled destructive dot', () => {
    const markup = renderMarkup('interrupted')
    const classNames = renderDotClassNames('interrupted')

    expect(markup).toContain('aria-label="Interrupted"')
    expect(classNames).toContain('bg-destructive')
    expect(classNames).not.toContain('bg-status-success')
  })

  it('renders active as full emerald dot', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-status-success')
  })

  it('renders done as an emerald dot', () => {
    const classNames = renderDotClassNames('done')

    expect(classNames).toContain('bg-status-success')
  })
})
