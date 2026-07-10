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
  it('renders working as a stepped yellow spinner', () => {
    const classNames = renderDotClassNames('working')

    expect(classNames).toContain('border-yellow-500')
    expect(classNames).toContain('border-t-transparent')
    expect(classNames).toContain('[animation:spin_1s_steps(12,end)_infinite]')
    expect(classNames).not.toContain('animate-spin')
  })

  it('renders permission as an amber attention dot', () => {
    const classNames = renderDotClassNames('permission')

    expect(classNames).toContain('bg-amber-500')
    expect(classNames).not.toContain('bg-red-500')
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
