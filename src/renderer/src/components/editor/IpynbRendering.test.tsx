// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IpynbCellOutputs } from './IpynbCellOutputs'
import { IpynbMarkdownCell, IpynbMarkdownCellEditor } from './IpynbCellEditor'
import { parseIpynb, type IpynbCell } from './ipynb-parse'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector({ settings: { theme: 'dark' } })
}))

function codeCell(outputs: IpynbCell['outputs']): IpynbCell {
  return {
    id: 'cell-1',
    kind: 'code',
    language: 'python',
    source: 'value',
    executionCount: 1,
    outputs
  }
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('notebook rendering', () => {
  it('uses the full Markdown pipeline for GFM and math', () => {
    render(<IpynbMarkdownCell source={'| A | B |\n| - | - |\n| 1 | 2 |\n\n$x^2$'} />)

    expect(document.querySelector('table')).not.toBeNull()
    expect(document.querySelector('.katex')).not.toBeNull()
  })

  it('renders Markdown as a document until editing is explicitly activated', () => {
    const onActivate = vi.fn()
    const onChange = vi.fn()
    const { container, rerender } = render(
      <IpynbMarkdownCellEditor
        source="# Report"
        active={false}
        onActivate={onActivate}
        onChange={onChange}
      />
    )

    expect(screen.queryByRole('textbox')).toBeNull()
    const preview = container.firstElementChild
    expect(preview?.getAttribute('role')).toBeNull()
    fireEvent.doubleClick(preview as Element)
    expect(onActivate).toHaveBeenCalledOnce()

    rerender(
      <IpynbMarkdownCellEditor
        source="# Report"
        active
        onActivate={onActivate}
        onChange={onChange}
      />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '# Updated' } })
    expect(onChange).toHaveBeenCalledWith('# Updated')
  })

  it('renders only the preferred representation from a display MIME bundle', () => {
    render(
      <IpynbCellOutputs
        cell={codeCell([
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

    const frame = screen.getByTitle('Notebook HTML output')
    expect(frame.getAttribute('srcdoc')).toContain('rich')
    expect(screen.queryByText('plain fallback')).toBeNull()
  })

  it('falls back from an empty preferred image and preserves image alternatives', () => {
    const { rerender } = render(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              { mime: 'image/png', value: '' },
              { mime: 'text/plain', value: 'fallback value' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByText('fallback value')).toBeTruthy()

    rerender(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              { mime: 'image/png', value: 'aW1hZ2U=' },
              { mime: 'text/plain', value: 'Chart of monthly totals' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByAltText('Chart of monthly totals')).toBeTruthy()
  })

  it.each([
    { mime: 'image/gif', showsImage: true },
    { mime: 'image/webp', showsImage: true },
    { mime: 'image/bmp', showsImage: true },
    // Chromium/Electron cannot decode TIFF, so the legible text/plain fallback must win.
    { mime: 'image/tiff', showsImage: false }
  ])('ranks $mime against a text/plain fallback', ({ mime, showsImage }) => {
    const notebook = parseIpynb(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { language_info: { name: 'python' } },
        cells: [
          {
            id: 'img-1',
            cell_type: 'code',
            metadata: {},
            execution_count: 1,
            source: ['plot()'],
            outputs: [
              {
                output_type: 'display_data',
                data: {
                  'text/plain': 'fallback',
                  [mime]: 'R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs='
                },
                metadata: {}
              }
            ]
          }
        ]
      })
    )
    expect(notebook.cells[0].outputs[0]).toMatchObject({ kind: 'display' })
    render(<IpynbCellOutputs cell={notebook.cells[0]} />)
    if (showsImage) {
      expect(screen.getByRole('img')).toBeTruthy()
      expect(screen.queryByText('fallback')).toBeNull()
    } else {
      expect(screen.getByText('fallback')).toBeTruthy()
      expect(screen.queryByRole('img')).toBeNull()
    }
  })

  it('rejects SVG output that sanitizes to empty content', () => {
    render(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              {
                mime: 'image/svg+xml',
                value: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
              },
              { mime: 'text/plain', value: 'SVG output unavailable' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByText('SVG output unavailable')).toBeTruthy()
  })

  it('falls back to text when an image payload is malformed Base64', () => {
    render(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              { mime: 'image/png', value: '!!!not-base64!!!' },
              { mime: 'text/plain', value: 'fallback text' }
            ]
          }
        ])}
      />
    )
    expect(screen.getByText('fallback text')).toBeTruthy()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('sanitizes HTML outputs and blocks scripts, links, and remote resources', () => {
    render(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [
              {
                mime: 'text/html',
                value:
                  '<script>alert(1)</script><a href="https://example.com">leave</a><img src="https://example.com/track.png"><b>safe</b>'
              }
            ]
          }
        ])}
      />
    )

    const source = screen.getByTitle('Notebook HTML output').getAttribute('srcdoc') ?? ''
    expect(source).not.toContain('<script')
    expect(source).toContain("default-src 'none'; img-src data:")
    expect(source).not.toContain('href=')
    expect(source).toContain('color-scheme: dark')
    expect(source).toContain('<b>safe</b>')
  })

  it('tracks stable HTML content height and disconnects its observer', () => {
    const observe = vi.fn()
    const disconnect = vi.fn()
    let resizeCallback: ResizeObserverCallback | null = null
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback
        }
        observe = observe
        disconnect = disconnect
      }
    )
    const { unmount } = render(
      <IpynbCellOutputs
        cell={codeCell([
          {
            kind: 'display',
            outputType: 'display_data',
            executionCount: null,
            items: [{ mime: 'text/html', value: '<details><summary>More</summary>Text</details>' }]
          }
        ])}
      />
    )
    const frame = screen.getByTitle('Notebook HTML output') as HTMLIFrameElement
    const body = frame.contentDocument?.body
    expect(body).toBeTruthy()
    vi.spyOn(body as HTMLElement, 'getBoundingClientRect').mockReturnValue({
      height: 120
    } as DOMRect)
    observe.mockClear()

    fireEvent.load(frame)
    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith(body)
    expect(frame.style.height).toBe('122px')

    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(frame.style.height).toBe('122px')
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
