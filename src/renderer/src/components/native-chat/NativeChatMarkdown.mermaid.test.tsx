// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }))
const theme = vi.hoisted(() => ({ value: 'light', listeners: new Set<() => void>() }))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: (svg: string) => svg } }))
vi.mock('@/store', async () => {
  const { useSyncExternalStore } = await import('react')
  const subscribe = (listener: () => void): (() => void) => {
    theme.listeners.add(listener)
    return () => theme.listeners.delete(listener)
  }
  return {
    useAppStore: (selector: (state: { settings: { theme: string } }) => unknown) =>
      selector({ settings: { theme: useSyncExternalStore(subscribe, () => theme.value) } })
  }
})

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

const heldRenders: PromiseWithResolvers<{ svg: string }>[] = []
/** Holds the next Mermaid render until the test settles it. */
function holdNextRender(): PromiseWithResolvers<{ svg: string }> {
  const held = Promise.withResolvers<{ svg: string }>()
  heldRenders.push(held)
  mermaid.render.mockReturnValueOnce(held.promise)
  return held
}

function setTheme(value: string): void {
  theme.value = value
  act(() => theme.listeners.forEach((listener) => listener()))
}

beforeEach(() => {
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue({ svg: '<svg><text>Sync with main once</text></svg>' })
})
afterEach(() => {
  cleanup()
  theme.value = 'light'
  // Renders share one queue: a render a failed test left held would stall the next test's.
  for (const held of heldRenders.splice(0)) {
    held.resolve({ svg: '<svg />' })
  }
})

describe('native chat Mermaid fences', () => {
  it('preserves the source node, horizontal scroll and focus while the completed diagram renders', async () => {
    const pending = holdNextRender()
    const wide = `flowchart LR\n A["${'Wide diagram source '.repeat(30)}"] --> B`
    const { container, rerender } = render(reply(wide, true))
    const source = container.querySelector('[data-code-language="mermaid"]')
    expect(source).not.toBeNull()
    const markup = source?.outerHTML
    const pre = container.querySelector('pre')
    if (!pre) {
      throw new Error('Missing diagram source')
    }
    pre.scrollLeft = 90
    const copy = screen.getByRole('button', { name: 'Copy code' })
    copy.focus()

    rerender(reply(wide, false))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(container.querySelector('[data-code-language="mermaid"]')?.outerHTML).toBe(markup)
    expect(container.querySelector('[data-code-language="mermaid"]')).toBe(source)
    expect(container.querySelector('pre')).toBe(pre)
    expect(pre.isConnected).toBe(true)
    expect(pre.scrollLeft).toBe(90)
    expect(screen.getByRole('button', { name: 'Copy code' })).toBe(copy)
    expect(copy).toHaveFocus()
    expect(container.querySelector('.mermaid-block')).toBeNull()

    await act(async () => pending.resolve({ svg: '<svg><text>Finished</text></svg>' }))
    expect(container.querySelector('svg')).toHaveTextContent('Finished')
    expect(container.querySelector('[data-code-language="mermaid"]')).toBeNull()
  })

  it('shows partial source while streaming and renders the diagram when the reply finishes', async () => {
    const { container, rerender } = render(reply(partial, true))
    expect(container.querySelector('[data-native-chat-code-content]')?.textContent).toContain(
      partial
    )
    expect(container.querySelector('[data-code-language="mermaid"]')).toBeInTheDocument()
    expect(container.querySelector('.mermaid-block')).toBeNull()

    rerender(reply(complete, true))
    expect(container.querySelector('pre')?.textContent).toContain(complete)

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

  it('keeps the source mounted until a pending diagram fails', async () => {
    const pending = holdNextRender()
    const view = render(reply(partial, true))
    const source = view.container.querySelector('pre')
    view.rerender(reply(partial, false))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(view.container.querySelector('pre')).toBe(source)
    expect(screen.queryByText(/Diagram error:/)).toBeNull()
    await act(async () => pending.reject(new Error('Invalid mermaid syntax')))
    expect(screen.getByText(/Diagram error: Invalid mermaid syntax/)).toBeInTheDocument()
    expect(view.container.querySelector('pre')?.textContent).toBe(partial.trimEnd())
  })

  it('waits for the updated diagram when a previously rendered fence grows again', async () => {
    const view = render(reply(complete, false))
    await waitFor(() =>
      expect(view.container.querySelector('.mermaid-block svg')).toBeInTheDocument()
    )
    const next = `${complete}\n B["Next step"]`
    view.rerender(reply(next, true))
    const source = view.container.querySelector('pre')
    expect(source).toHaveTextContent('Next step')
    const pending = holdNextRender()
    view.rerender(reply(next, false))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(view.container.querySelector('pre')).toBe(source)
    expect(view.container.querySelector('.mermaid-block svg')).toBeNull()
    await act(async () => pending.resolve({ svg: '<svg><text>Next step</text></svg>' }))
    expect(view.container.querySelector('.mermaid-block svg')).toHaveTextContent('Next step')
  })

  it('does not run Mermaid on a reply that is still streaming', async () => {
    const finished = 'flowchart TD\n S["Finished elsewhere"]'
    render(
      <>
        {reply(partial, true)}
        {reply(finished, false)}
      </>
    )
    // Renders run in order, so the finished diagram rendering means the streaming one's turn passed.
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledWith(expect.any(String), finished))
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it('keeps the rendered diagram through a theme change until the new one is ready', async () => {
    const view = render(reply(complete, false))
    await waitFor(() =>
      expect(view.container.querySelector('.mermaid-block svg')).toBeInTheDocument()
    )
    const pending = holdNextRender()
    setTheme('dark')
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(view.container.querySelector('.mermaid-block svg')).toHaveTextContent(
      'Sync with main once'
    )
    expect(view.container.querySelector('[data-code-language="mermaid"]')).toBeNull()
    await act(async () => pending.resolve({ svg: '<svg><text>Dark</text></svg>' }))
    expect(view.container.querySelector('.mermaid-block svg')).toHaveTextContent('Dark')
  })
})
