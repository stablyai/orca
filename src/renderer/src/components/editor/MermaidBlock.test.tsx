// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, content: string) => Promise<{ svg: string }>>(),
  sanitize: vi.fn<(svg: string, config?: unknown) => string>()
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: mermaid.sanitize } }))

import MermaidBlock from './MermaidBlock'
import { mermaidSvgSanitizeConfig } from './mermaid-sanitize'
import { settleMermaidNavigation } from './use-mermaid-viewport'

const partial = 'flowchart TD\n A["Sync with main '
const complete = `${partial}once"]`
const diagram = '<svg><text>Sync with main once</text></svg>'

beforeEach(() => {
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue({ svg: diagram })
  mermaid.sanitize.mockReset().mockImplementation((svg) => svg)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('MermaidBlock rendering', () => {
  it('defers an offscreen document diagram, then keeps its SVG after leaving and re-entering', async () => {
    let notify: ((isIntersecting: boolean) => void) | undefined
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(
          callback: (entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]) => void
        ) {
          notify = (isIntersecting) => callback([{ isIntersecting }])
        }
        observe() {}
        disconnect() {}
      }
    )
    const { container, rerender } = render(<MermaidBlock content={complete} isDark={false} lazy />)
    await act(async () => {})
    expect(mermaid.render).not.toHaveBeenCalled()
    expect(container.querySelector('svg')).toBeNull()

    act(() => notify?.(true))
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    )
    rerender(<MermaidBlock content={complete} isDark={false} lazy />)
    act(() => notify?.(false))
    act(() => notify?.(true))
    await act(async () => {})
    expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it.each(['pointer', 'keyboard', 'editing'] as const)(
    'does not recenter the rich editor after the user resumes %s interaction',
    async (interaction) => {
      vi.stubGlobal(
        'IntersectionObserver',
        class {
          observe() {}
          disconnect() {}
        }
      )
      const pending = Promise.withResolvers<{ svg: string }>()
      mermaid.render.mockReturnValueOnce(pending.promise)
      const { container } = render(
        <div className="rich-markdown-editor-shell">
          <div className="overflow-auto">
            <div className="ProseMirror" contentEditable suppressContentEditableWarning>
              <MermaidBlock content={complete} isDark={false} lazy />
            </div>
          </div>
        </div>
      )
      const viewport = container.querySelector<HTMLElement>('.overflow-auto')!
      const editor = container.querySelector<HTMLElement>('.ProseMirror')!
      act(() => {
        settleMermaidNavigation(viewport, () => {
          viewport.scrollTop = 100
        })
      })
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
      if (interaction === 'pointer') {
        fireEvent.pointerDown(editor)
      } else if (interaction === 'keyboard') {
        fireEvent.keyDown(editor, { key: 'PageDown' })
      } else {
        fireEvent(editor, new Event('beforeinput', { bubbles: true }))
      }
      viewport.scrollTop = 800
      await act(async () => pending.resolve({ svg: diagram }))
      expect(viewport.scrollTop).toBe(800)
      expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    }
  )

  it('keeps a document diagram visible while edited source renders', async () => {
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(
          private readonly notify: (
            entries: Pick<IntersectionObserverEntry, 'isIntersecting'>[]
          ) => void
        ) {}
        observe() {
          this.notify([{ isIntersecting: true }])
        }
        disconnect() {}
      }
    )
    const { container, rerender } = render(
      <MermaidBlock content={complete} isDark={false} lazy pendingContent={<div />} />
    )
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    )
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    rerender(
      <MermaidBlock
        content={`${complete}\n B --> C`}
        isDark={false}
        lazy
        pendingContent={<div />}
      />
    )
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
    expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    await act(async () => {
      pending.resolve({ svg: '<svg><text>Edited diagram</text></svg>' })
    })
    expect(container.querySelector('svg')).toHaveTextContent('Edited diagram')
  })

  it('offers to expand a rendered diagram, but not its source or an error', async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    const onExpand = vi.fn()
    const { container, rerender } = render(
      <MermaidBlock
        content={complete}
        isDark={false}
        pendingContent={<pre>{complete}</pre>}
        onExpand={onExpand}
      />
    )
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull()

    await act(async () => pending.resolve({ svg: diagram }))
    const expand = screen.getByRole('button', { name: 'Expand diagram' })
    // PDF/HTML export strips this marker; the export page has no Tailwind to hide the button.
    expect(expand.hasAttribute('data-orca-export-hide')).toBe(true)
    fireEvent.click(container.querySelector('svg')!)
    expect(onExpand).toHaveBeenCalledWith({ svg: diagram, background: undefined })
    expect(document.activeElement).toBe(expand)

    const selection = vi.spyOn(window, 'getSelection')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the component only reads isCollapsed.
    selection.mockReturnValue({ isCollapsed: false } as Selection)
    fireEvent.click(container.querySelector('svg')!)
    expect(onExpand).toHaveBeenCalledTimes(1)
    fireEvent.click(expand)
    expect(onExpand).toHaveBeenCalledTimes(2)
    selection.mockRestore()

    mermaid.render.mockRejectedValueOnce(new Error('Parse error'))
    rerender(<MermaidBlock content={partial} isDark={false} onExpand={onExpand} />)
    await screen.findByText(/Diagram error: Parse error/)
    expect(screen.queryByRole('button', { name: 'Expand diagram' })).toBeNull()
  })

  it('keeps the displayed source in place until the SVG is ready', async () => {
    const pending = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(pending.promise)
    const { container } = render(
      <MermaidBlock
        content={complete}
        isDark={false}
        className="diagram-frame"
        pendingContent={<pre data-testid="pending-source">{complete}</pre>}
      />
    )
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    expect(screen.getByTestId('pending-source').textContent).toBe(complete)
    expect(container.querySelector('.diagram-frame')).toBeNull()
    expect(container.querySelector('.mermaid-block')).toBeNull()

    await act(async () => pending.resolve({ svg: diagram }))
    expect(container.querySelector('.diagram-frame svg')).toHaveTextContent('Sync with main once')
    expect(screen.queryByTestId('pending-source')).toBeNull()
  })

  it('replaces an invalid partial source error with the completed diagram', async () => {
    mermaid.render.mockRejectedValueOnce(new Error('Parse error on line 2'))
    const { container, rerender } = render(<MermaidBlock content={partial} isDark={false} />)
    await screen.findByText(/Diagram error: Parse error on line 2/)
    expect(container.querySelector('pre')?.textContent).toBe(partial)

    rerender(<MermaidBlock content={complete} isDark={false} />)
    await waitFor(() =>
      expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
    )
    expect(screen.queryByText(/Diagram error:/)).not.toBeInTheDocument()
    expect(container.querySelector('pre')).toBeNull()
  })

  it.each(['success', 'failure'])(
    'ignores an obsolete render %s after content changes',
    async (outcome) => {
      const obsolete = Promise.withResolvers<{ svg: string }>()
      const current = Promise.withResolvers<{ svg: string }>()
      mermaid.render.mockReturnValueOnce(obsolete.promise).mockReturnValueOnce(current.promise)
      const { container, rerender } = render(<MermaidBlock content={partial} isDark={false} />)
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
      rerender(<MermaidBlock content={complete} isDark={false} />)

      await act(async () => {
        if (outcome === 'success') {
          obsolete.resolve({ svg: '<svg><text>Obsolete</text></svg>' })
        } else {
          obsolete.reject(new Error('Obsolete parse error'))
        }
        await obsolete.promise.catch(() => {})
      })
      await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
      expect(container).not.toHaveTextContent('Obsolete')
      await act(async () => current.resolve({ svg: diagram }))
      await waitFor(() =>
        expect(container.querySelector('svg')).toHaveTextContent('Sync with main once')
      )
      expect(container.querySelector('.mermaid-error')).toBeNull()
    }
  )

  it('sanitizes the successful SVG before displaying it', async () => {
    const unsafeSvg =
      '<svg onload="alert(1)"><script>alert(1)</script><text>Safe diagram</text></svg>'
    mermaid.render.mockResolvedValue({ svg: unsafeSvg })
    mermaid.sanitize.mockReturnValueOnce('<svg><text>Safe diagram</text></svg>')
    const { container } = render(<MermaidBlock content={complete} isDark={false} />)
    await screen.findByText('Safe diagram')
    expect(mermaid.sanitize).toHaveBeenCalledWith(unsafeSvg, mermaidSvgSanitizeConfig)
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('svg')).not.toHaveAttribute('onload')
  })

  it('keeps new diagrams queued behind a render already in progress', async () => {
    const first = Promise.withResolvers<{ svg: string }>()
    const second = Promise.withResolvers<{ svg: string }>()
    mermaid.render.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { rerender } = render(
      <>
        <MermaidBlock content="first" isDark={false} />
        <MermaidBlock content="second" isDark={false} />
      </>
    )
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    await act(async () => first.resolve({ svg: diagram }))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))

    rerender(
      <>
        <MermaidBlock content="first" isDark={false} />
        <MermaidBlock content="second" isDark={false} />
        <MermaidBlock content="third" isDark={false} />
      </>
    )
    await act(async () => {})
    expect(mermaid.render).toHaveBeenCalledTimes(2)
    await act(async () => second.resolve({ svg: diagram }))
    await waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(3))
  })
})
