// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbCellSource, IpynbMarkdownCell } from './IpynbCellEditor'
import { IpynbRunPrompt } from './IpynbCellToolbar'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { IpynbCell, IpynbOutput } from './ipynb-parse'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./use-document-dark-theme', () => ({ useDocumentDarkTheme: () => true }))
vi.mock('@/lib/monaco-setup', () => ({ monaco: {} }))
vi.mock('./MonacoCodeExcerpt', () => ({
  useMonacoColorizedLines: () => []
}))

function cell(kind: IpynbCell['kind'], source: string, outputs: IpynbOutput[] = []): IpynbCell {
  return { id: 'cell-1', kind, language: 'python', source, executionCount: 1, outputs }
}

function renderSource(target: IpynbCell, onActivate = vi.fn()) {
  render(
    <IpynbCellSource
      cell={target}
      source={target.source}
      active={false}
      onActivate={onActivate}
      onDeactivate={vi.fn()}
      onChange={vi.fn()}
    />
  )
  return onActivate
}

afterEach(cleanup)

describe('notebook cell source', () => {
  it('renders markdown through the full preview pipeline (GFM + math)', () => {
    render(<IpynbMarkdownCell source={'| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$'} />)
    expect(document.querySelector('table')).not.toBeNull()
    expect(document.querySelector('.katex')).not.toBeNull()
  })

  it('shows markdown as a document and edits only on double-click or Enter', () => {
    const onActivate = renderSource(cell('markdown', '# Report'))
    const preview = screen.getByRole('button')
    expect(screen.getByRole('heading', { name: 'Report' })).toBeTruthy()

    fireEvent.click(preview)
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.doubleClick(preview)
    fireEvent.keyDown(preview, { key: 'Enter' })
    expect(onActivate).toHaveBeenCalledTimes(2)
  })

  it('activates code cells on primary press so a collapsing neighbour cannot swallow the click', () => {
    const onActivate = renderSource(cell('code', 'print(1)'))
    const preview = screen.getByRole('button')
    fireEvent.mouseDown(preview, { button: 2 })
    expect(onActivate).not.toHaveBeenCalled()
    fireEvent.mouseDown(preview, { button: 0 })
    expect(onActivate).toHaveBeenCalledOnce()
  })
})

describe('notebook code preview', () => {
  it('shows source as literal text until Monaco colorizes it', () => {
    renderSource(cell('code', 'x = "<b>hi</b>"\n'))
    expect(screen.getByText('x = "<b>hi</b>"')).toBeTruthy()
    expect(document.querySelector('b')).toBeNull()
    // The trailing newline keeps its own row, matching the Monaco model.
    expect(document.querySelectorAll('code')).toHaveLength(2)
  })
})

describe('notebook run prompt', () => {
  it('shows the count above the run button and [*] with the button disabled while running', () => {
    const { rerender } = render(
      <IpynbRunPrompt executionCount={3} running={false} onRun={vi.fn()} />,
      { wrapper: TooltipProvider }
    )
    expect(screen.getByText('[3]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run cell' }).hasAttribute('disabled')).toBe(false)

    rerender(<IpynbRunPrompt executionCount={3} running onRun={vi.fn()} />)
    expect(screen.getByText('[*]')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Run cell' }).hasAttribute('disabled')).toBe(true)
  })
})

describe('notebook outputs', () => {
  it('renders only the richest representation of a display bundle', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'df', [
          {
            kind: 'display',
            outputType: 'execute_result',
            executionCount: 1,
            items: [
              { mime: 'text/html', value: '<table><tr><td>rich</td></tr></table>' },
              { mime: 'text/plain', value: 'plain fallback' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByTitle('Notebook HTML output').getAttribute('srcdoc')).toContain('rich')
    expect(screen.queryByText('plain fallback')).toBeNull()
  })

  it('skips MIME types it cannot render in favour of the text fallback', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'w', [
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              { mime: 'application/vnd.custom-widget', value: {} },
              { mime: 'text/plain', value: 'widget repr' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByText('widget repr')).toBeTruthy()
  })

  it('colours ANSI tracebacks instead of printing escape codes', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', '1/0', [
          {
            kind: 'error',
            name: 'ZeroDivisionError',
            message: 'division by zero',
            traceback: '\u001b[0;31mZeroDivisionError\u001b[0m: division by zero'
          }
        ])}
      />
    )
    const name = screen.getByText('ZeroDivisionError')
    expect(name.tagName).toBe('SPAN')
    expect(name.style.color).not.toBe('')
    expect(document.body.textContent).not.toContain('\u001b')
  })

  it('sandboxes HTML output behind a no-network CSP and strips scripts', () => {
    render(
      <IpynbCellOutputs
        cell={cell('code', 'html', [
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [{ mime: 'text/html', value: '<script>alert(1)</script><b>safe</b>' }]
          }
        ])}
      />
    )
    const frame = screen.getByTitle('Notebook HTML output')
    const source = frame.getAttribute('srcdoc') ?? ''
    // An empty sandbox keeps the frame an opaque origin with scripts off.
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain('<script')
    expect(source).toContain('<b>safe</b>')
  })
})
