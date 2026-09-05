import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

vi.mock('@/components/StateIndicatorTooltip', async () => {
  const { createElement } = await import('react')
  return {
    StateIndicatorTooltip: ({
      label,
      children
    }: {
      label: string | null
      children: React.ReactElement
    }) =>
      label === null
        ? children
        : createElement('span', { 'data-state-indicator-tooltip': label }, children)
  }
})

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

  it('renders monitoring as a static heartbeat glyph', () => {
    const markup = renderMarkup('monitoring')

    expect(markup).toContain('data-state-indicator-tooltip="Monitoring background tasks"')
    expect(markup).not.toContain(' title=')
    expect(markup).toContain('lucide-activity')
    expect(markup).toContain('text-yellow-500')
    expect(markup).not.toContain('data-agent-spinner')
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

  it('renders interrupted distinctly from done', () => {
    const classNames = renderDotClassNames('interrupted')

    expect(classNames).toContain('bg-red-500')
    expect(classNames).not.toContain('bg-emerald-500')
  })

  it.each([
    ['working', 'Working'],
    ['monitoring', 'Monitoring background tasks'],
    ['permission', 'Needs permission'],
    ['interrupted', 'Interrupted'],
    ['done', 'Done']
  ] as const)('labels the agent-derived %s workspace state', (status, label) => {
    const markup = renderMarkup(status)

    expect(markup).toContain(`data-state-indicator-tooltip="${label}"`)
    expect(markup).not.toContain(' title=')
  })

  it.each(['active', 'inactive'] as const)(
    'does not label the passive %s workspace state',
    (status) => {
      const markup = renderMarkup(status)

      expect(markup).not.toContain('data-state-indicator-tooltip')
      expect(markup).not.toContain(' title=')
    }
  )

  it('lets an enclosing action own the tooltip', () => {
    const markup = renderToStaticMarkup(
      React.createElement(StatusIndicator, { status: 'working', showTooltip: false })
    )

    expect(markup).not.toContain('data-state-indicator-tooltip')
    expect(markup).toContain('data-agent-spinner')
  })
})
