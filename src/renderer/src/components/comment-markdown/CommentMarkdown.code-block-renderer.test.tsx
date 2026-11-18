// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./CommentMermaidBlock', () => ({
  default: () => <div data-testid="diagram" />
}))

import CommentMarkdown from './CommentMarkdown'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function StatefulCodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const [label] = useState('stateful')
  useEffect(() => {}, [label])
  return <pre data-block={label}>{children}</pre>
}

function markdown(renderMermaid: boolean): React.JSX.Element {
  return (
    <CommentMarkdown
      variant="document"
      content={'```mermaid\nflowchart TD\n A --> B\n```'}
      renderCodeBlock={StatefulCodeBlock}
      renderMermaid={renderMermaid}
    />
  )
}

describe('CommentMarkdown document code-block renderer', () => {
  it('keeps a stateful renderer to its own hooks as a fence switches between diagram and code', () => {
    const consoleError = vi.spyOn(console, 'error')
    const view = render(markdown(true))
    expect(view.getByTestId('diagram')).toBeTruthy()

    view.rerender(markdown(false))
    view.rerender(markdown(true))
    view.rerender(markdown(false))

    expect(view.queryByTestId('diagram')).toBeNull()
    expect(view.container.querySelector('[data-block="stateful"]')).not.toBeNull()
    expect(consoleError).not.toHaveBeenCalled()
  })
})
