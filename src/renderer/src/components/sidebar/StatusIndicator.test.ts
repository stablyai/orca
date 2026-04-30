import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import StatusIndicator, { type Status } from './StatusIndicator'

function renderDotClassNames(status: Status): string[] {
  const markup = renderToStaticMarkup(React.createElement(StatusIndicator, { status }))
  const dotClassName = markup.match(/<span class="([^"]*rounded-full[^"]*)"/)?.[1]

  expect(dotClassName).toBeDefined()

  return dotClassName!.split(/\s+/)
}

describe('StatusIndicator', () => {
  it('renders active as dimmer emerald', () => {
    const classNames = renderDotClassNames('active')

    expect(classNames).toContain('bg-emerald-500/60')
    expect(classNames).not.toContain('bg-emerald-500')
  })

  it('renders done as full emerald', () => {
    const classNames = renderDotClassNames('done')

    expect(classNames).toContain('bg-emerald-500')
    expect(classNames).not.toContain('bg-emerald-500/60')
  })
})
