// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => {
  const mockState = { keybindings: {}, settings: { theme: 'light' } }
  const useAppStore = Object.assign(
    (selector: (state: typeof mockState) => unknown) => selector(mockState),
    { getState: () => mockState }
  )
  return { useAppStore }
})

vi.mock('./MermaidBlock', () => ({
  default: ({ content }: { content: string }) => <div data-testid="mermaid-block">{content}</div>
}))

vi.mock('./ZoomableDiagramSurface', () => ({
  default: ({ children, diagramKey }: { children: ReactNode; diagramKey: string }) => (
    <div data-diagram-key={diagramKey} data-testid="diagram-surface">
      {children}
    </div>
  )
}))

import MermaidViewer from './MermaidViewer'
import { MERMAID_RENDER_DEBOUNCE_MS } from './use-debounced-mermaid-diagram-content'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('MermaidViewer', () => {
  it('edits source in split mode and rerenders the diagram from the draft', () => {
    vi.useFakeTimers()
    const onContentChange = vi.fn()

    render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/demo.mmd"
        onContentChange={onContentChange}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Split' }))
    fireEvent.change(screen.getByLabelText('Mermaid source'), {
      target: { value: 'flowchart TD\n  A --> C' }
    })

    expect(onContentChange).toHaveBeenLastCalledWith('flowchart TD\n  A --> C')
    act(() => {
      vi.advanceTimersByTime(MERMAID_RENDER_DEBOUNCE_MS)
    })
    expect(screen.getByTestId('diagram-surface').getAttribute('data-diagram-key')).toBe(
      'flowchart TD\n  A --> C'
    )
    expect(screen.getByTestId('mermaid-block').textContent).toContain('A --> C')
  })

  it('keeps code mode editable without rendering the diagram panel', () => {
    render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Code' }))

    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).readOnly).toBe(false)
    expect(screen.queryByTestId('diagram-surface')).toBeNull()
  })

  it('keeps a new empty diagram editable after the first input', () => {
    vi.useFakeTimers()

    render(<MermaidViewer content="" filePath="/repo/new.mmd" onContentChange={vi.fn()} />)

    fireEvent.change(screen.getByLabelText('Mermaid source'), {
      target: { value: 'flowchart LR\n  Start --> Done' }
    })

    expect(screen.getByRole('radio', { name: 'Split' }).getAttribute('aria-checked')).toBe('true')
    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(
      'flowchart LR\n  Start --> Done'
    )
    act(() => {
      vi.advanceTimersByTime(MERMAID_RENDER_DEBOUNCE_MS)
    })
    expect(screen.getByTestId('diagram-surface').getAttribute('data-diagram-key')).toBe(
      'flowchart LR\n  Start --> Done'
    )
  })

  it('keeps the draft when parent content echoes back for the same file', () => {
    const { rerender } = render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Code' }))
    fireEvent.change(screen.getByLabelText('Mermaid source'), {
      target: { value: 'flowchart TD\n  A --> Draft' }
    })

    rerender(
      <MermaidViewer
        content={'flowchart TD\n  A --> Draft'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
      />
    )

    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(
      'flowchart TD\n  A --> Draft'
    )
  })

  it('accepts external content updates for the same file (reload, external edit)', () => {
    const { rerender } = render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Split' }))

    rerender(
      <MermaidViewer
        content={'flowchart TD\n  A --> Reloaded'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
      />
    )

    expect((screen.getByLabelText('Mermaid source') as HTMLTextAreaElement).value).toBe(
      'flowchart TD\n  A --> Reloaded'
    )
  })

  it('keeps read-only files immutable and suppresses the save shortcut', () => {
    const onSave = vi.fn()

    render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/demo.mmd"
        onContentChange={vi.fn()}
        onSave={onSave}
        readOnly
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Code' }))
    const source = screen.getByLabelText('Mermaid source') as HTMLTextAreaElement
    const modifier = navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true }
    fireEvent.keyDown(source, { key: 's', code: 'KeyS', ...modifier })

    expect(source.readOnly).toBe(true)
    expect(onSave).not.toHaveBeenCalled()
  })

  it('flushes the diagram immediately when switching to a different file', () => {
    vi.useFakeTimers()

    const { rerender } = render(
      <MermaidViewer
        content={'flowchart TD\n  A --> B'}
        filePath="/repo/first.mmd"
        onContentChange={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('radio', { name: 'Chart' }))
    expect(screen.getByTestId('diagram-surface').getAttribute('data-diagram-key')).toBe(
      'flowchart TD\n  A --> B'
    )

    rerender(
      <MermaidViewer
        content={'flowchart TD\n  X --> Y'}
        filePath="/repo/second.mmd"
        onContentChange={vi.fn()}
      />
    )

    expect(screen.getByTestId('diagram-surface').getAttribute('data-diagram-key')).toBe(
      'flowchart TD\n  X --> Y'
    )
  })
})
