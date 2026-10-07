// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('./CommentMermaidBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="mermaid-diagram">{content}</div>
}))

import { renderMermaidFence } from './comment-mermaid-fence'

// The issue's mid-stream fence: the closing quote and bracket never arrived.
const TRUNCATED_DIAGRAM = `flowchart TD
  A["起点"] --> B["上下文不够用<br/>它没有「这是第几轮」`

const CLOSED_DIAGRAM = `${TRUNCATED_DIAGRAM}"]`

const MID_SYNTAX_DIAGRAM = `flowchart TD
  A --> B
  this is not valid
  C --> D`

afterEach(() => {
  cleanup()
})

describe('renderMermaidFence', () => {
  it('keeps an open fence as source even when the body already parses', () => {
    const view = render(renderMermaidFence('graph TD\n  A-->B', 'diagram-wrap', false))

    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    expect(view.container.querySelector('pre')).not.toBeNull()

    view.rerender(renderMermaidFence('graph TD\n  A-->B\n  B-->C', 'diagram-wrap', false))

    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    expect(view.container.querySelector('pre')).not.toBeNull()
    expect(screen.getByText(/B-->C/)).toBeTruthy()
  })

  it('keeps a cut-off mermaid fence as source instead of mounting the diagram', () => {
    render(renderMermaidFence(TRUNCATED_DIAGRAM, 'diagram-wrap', false))

    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
    expect(screen.getByText(/上下文不够用/)).toBeTruthy()
  })

  it('mounts the diagram once the same fence is closed', () => {
    render(renderMermaidFence(CLOSED_DIAGRAM, 'diagram-wrap', true))

    expect(screen.getByTestId('mermaid-diagram').textContent).toContain('上下文不够用')
  })

  it('mounts a closed fence even when the body fails at end of input', () => {
    render(renderMermaidFence(TRUNCATED_DIAGRAM, 'diagram-wrap', true))

    expect(screen.getByTestId('mermaid-diagram').textContent).toContain('上下文不够用')
  })

  it('still mounts a finished diagram that Mermaid rejects for a real syntax error', () => {
    render(renderMermaidFence(MID_SYNTAX_DIAGRAM, 'diagram-wrap', true))

    expect(screen.getByTestId('mermaid-diagram').textContent).toContain('this is not valid')
  })
})
