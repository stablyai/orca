// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn<(id: string, content: string) => Promise<{ svg: string }>>(),
  sanitize: vi.fn<(svg: string) => string>()
}))
vi.mock('mermaid', () => ({ default: mermaid }))
vi.mock('dompurify', () => ({ default: { sanitize: mermaid.sanitize } }))

import MermaidBlock from './MermaidBlock'

const partial = 'flowchart TD\n A["Sync with main '
const complete = `${partial}once"]`
const diagram = '<svg><text>Sync with main once</text></svg>'

beforeEach(() => {
  mermaid.render.mockReset()
  mermaid.render.mockResolvedValue({ svg: diagram })
  mermaid.sanitize.mockReset().mockImplementation((svg) => svg)
})
afterEach(cleanup)

describe('MermaidBlock rendering', () => {
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
    expect(mermaid.sanitize).toHaveBeenCalledWith(unsafeSvg, { USE_PROFILES: { svg: true } })
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
