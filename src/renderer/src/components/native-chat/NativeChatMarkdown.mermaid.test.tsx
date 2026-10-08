// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
    selector({ settings: { theme: 'light' } })
}))

import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatCodeBlock } from './NativeChatCodeBlock'
import { TooltipProvider } from '@/components/ui/tooltip'

const partial = 'flowchart TD\n A["Sync with main '
const complete = `${partial}once"]`

function reply(source: string, streaming: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatMarkdown
        content={`Here is the plan:\n\n\`\`\`mermaid\n${source}${streaming ? '' : '\n```'}`}
        variant="document"
        renderCodeBlock={NativeChatCodeBlock}
        streaming={streaming}
      />
    </TooltipProvider>
  )
}

beforeEach(() => {
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue({ svg: '<svg><text>Sync with main once</text></svg>' })
})
afterEach(cleanup)

describe('native chat Mermaid fences', () => {
  it('shows partial source while streaming and renders the diagram when the reply finishes', async () => {
    const { container, rerender } = render(reply(partial, true))
    expect(container.querySelector('[data-native-chat-code-content]')?.textContent).toContain(
      partial
    )
    expect(container.querySelector('[data-code-language="mermaid"]')).toBeInTheDocument()
    expect(container.querySelector('.mermaid-block')).toBeNull()
    expect(mermaid.render).not.toHaveBeenCalled()

    rerender(reply(complete, true))
    expect(container.querySelector('pre')?.textContent).toContain(complete)
    expect(mermaid.render).not.toHaveBeenCalled()

    rerender(reply(complete, false))
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    )
    expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), complete)
    expect(container.querySelector('pre')).toBeNull()
    expect(screen.queryByText(/Diagram error:/)).not.toBeInTheDocument()
  })

  it('still shows the existing error and source for an invalid finished reply', async () => {
    mermaid.render.mockRejectedValue(new Error('Invalid mermaid syntax'))
    const { container } = render(reply(partial, false))
    await screen.findByText(/Diagram error: Invalid mermaid syntax/)
    expect(container.querySelector('pre')?.textContent).toBe(partial.trimEnd())
    expect(container.querySelector('svg')).toBeNull()
  })
})
