// @vitest-environment happy-dom
import { useState } from 'react'
import { renderHook, cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CsvViewer from './CsvViewer'
import { useCsvTableEditor } from './useCsvTableEditor'
import { parseCsvTextDocument } from './csv-text-document'
import {
  flushPendingEditorBuffer,
  hasPendingEditorBufferChange
} from '../save/flush/editor-pending-flush'
import { APP_MENU_PASTE_EVENT } from '@/lib/clipboard/menu/app-menu-paste'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '../autosave/editor-autosave'
import { EMPTY_EDITOR_BUFFER_VIEW_INDEX as NO_SHARING } from '@/store/slices/editor/buffers/editor-buffer-views'

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    estimateSize,
    paddingStart = 0
  }: {
    count: number
    estimateSize: (index: number) => number
    paddingStart?: number
  }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 20) }, (_, index) => ({
        index,
        key: index,
        start: paddingStart + index * estimateSize(index),
        size: estimateSize(index),
        end: paddingStart + (index + 1) * estimateSize(index)
      })),
    getTotalSize: () => paddingStart + count * estimateSize(0),
    resizeItem: vi.fn(),
    measure: vi.fn(),
    scrollToIndex: vi.fn()
  })
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  localStorage.clear()
  Reflect.deleteProperty(window, 'api')
})

function setup(source = '\ufeffname,value\r\nB,2\r\nA,1') {
  const changes = vi.fn()
  const save = vi.fn().mockResolvedValue(true)
  function Editor() {
    const [content, setContent] = useState(source)
    const [dirty, setDirty] = useState(false)
    return (
      <>
        <CsvViewer
          content={content}
          filePath="test.csv"
          fileId="csv-edit-test"
          isDirty={dirty}
          onDirtyStateHint={setDirty}
          onContentChange={(next) => {
            changes(next)
            setContent(next)
            setDirty(next !== source)
          }}
          onSave={save}
        />
        <output data-testid="source">{content}</output>
        <output data-testid="dirty">{String(dirty)}</output>
      </>
    )
  }
  return { ...render(<Editor />), changes, save }
}

function edit(value: string, next: string): HTMLElement {
  fireEvent.doubleClick(screen.getByRole('gridcell', { name: value }))
  const input = screen.getByRole('textbox', { name: /Edit row/ })
  fireEvent.change(input, { target: { value: next } })
  return input
}

describe('editable CSV table', () => {
  it('commits escaped multiline values while preserving BOM, endings and source order', () => {
    const { changes } = setup()
    const input = edit('B', 'x,"quoted"\nnext')
    expect(screen.getByTestId('dirty').textContent).toBe('true')
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('source').textContent).toBe(
      '\ufeffname,value\r\n"x,""quoted""\nnext",2\r\nA,1'
    )
  })

  it('Escape cancels before the following blur can commit, preserving earlier dirty state', () => {
    const { changes } = setup()
    fireEvent.keyDown(edit('B', 'discarded'), { key: 'Escape' })
    expect(changes).not.toHaveBeenCalled()
    expect(screen.getByTestId('dirty').textContent).toBe('false')
    fireEvent.keyDown(edit('B', 'kept'), { key: 'Enter' })
    fireEvent.keyDown(edit('A', 'discarded too'), { key: 'Escape' })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('dirty').textContent).toBe('true')
  })

  it('edits a filtered row in its original source position', () => {
    setup()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter rows' }), {
      target: { value: 'A' }
    })
    fireEvent.keyDown(edit('1', 'updated'), { key: 'Enter' })
    expect(screen.getByTestId('source').textContent).toBe('\ufeffname,value\r\nB,2\r\nA,updated')
  })

  it('cancels only the new cell after an earlier save completes', () => {
    setup()
    fireEvent.keyDown(edit('B', 'saved base'), { key: 'Enter' })
    const source = screen.getByTestId('source').textContent
    const input = edit('A', 'new pending cell')
    expect(hasPendingEditorBufferChange(NO_SHARING, 'csv-edit-test')).toBe(true)
    act(() =>
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, {
          detail: { fileId: 'csv-edit-test', content: source }
        })
      )
    )
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(hasPendingEditorBufferChange(NO_SHARING, 'csv-edit-test')).toBe(false)
    expect(screen.getByTestId('dirty').textContent).toBe('false')
    expect(screen.getByTestId('source').textContent).toBe(source)
  })

  it('blocks table mutations after a rejected pending edit and preserves its recovery draft', () => {
    const { changes, unmount } = setup()
    const value = 'x'.repeat(1024 * 1024 + 1)
    fireEvent.keyDown(edit('B', value), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('button', { name: 'Rows' }), {
      key: 'ArrowDown'
    })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Insert row below' }))
    expect(changes).not.toHaveBeenCalled()
    expect(screen.getByTestId('source').textContent).toBe('\ufeffname,value\r\nB,2\r\nA,1')
    unmount()
    expect(changes).toHaveBeenCalledWith(`\ufeffname,value\r\n${value},2\r\nA,1`)
  })

  it('applies a pending cell and a subsequent structural mutation atomically', () => {
    const changes = vi.fn()
    const { result } = renderHook(() =>
      useCsvTableEditor({
        document: parseCsvTextDocument('name,value\nB,2', ','),
        inspectionRows: null,
        onContentChange: changes,
        onStructureChange: vi.fn()
      })
    )
    act(() => result.current.edit(1, 0))
    act(() => result.current.interaction?.change('pending'))
    act(() =>
      expect(result.current.apply({ kind: 'insert-column', at: 1, label: 'new' })).toBe(true)
    )
    expect(changes).toHaveBeenCalledExactlyOnceWith('name,new,value\npending,,2')
    expect(result.current.interaction?.editing).toBeNull()
  })

  it('routes menu paste only to the focused grid when two file panes are mounted', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const read = vi.fn().mockResolvedValue('pasted')
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { readClipboardText: read } }
    })
    render(
      <>
        <CsvViewer content={'header\nfirst'} filePath="first.csv" onContentChange={first} />
        <CsvViewer content={'header\nsecond'} filePath="second.csv" onContentChange={second} />
      </>
    )
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'first' }), { button: 0 })
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'second' }), { button: 0 })
    await act(async () => {
      window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
      await Promise.resolve()
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledWith('header\npasted')
  })

  it('cancels delayed app-menu paste when focus moves to another file pane', async () => {
    const first = vi.fn()
    const second = vi.fn()
    let resolveRead: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      resolveRead = resolve
    })
    const read = vi.fn(() => pending)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { readClipboardText: read } }
    })
    render(
      <>
        <CsvViewer content={'header\nfirst'} filePath="first.csv" onContentChange={first} />
        <CsvViewer content={'header\nsecond'} filePath="second.csv" onContentChange={second} />
      </>
    )
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'first' }), { button: 0 })
    act(() => {
      window.dispatchEvent(new Event(APP_MENU_PASTE_EVENT, { cancelable: true }))
    })
    expect(read).toHaveBeenCalledTimes(1)
    act(() => {
      screen.getAllByRole('grid')[1]?.focus()
    })
    await act(async () => {
      resolveRead('stale paste')
      await pending
    })
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('flushes an edited pane even when another pane of the same file registered later', () => {
    const first = vi.fn()
    const second = vi.fn()
    render(
      <>
        <CsvViewer
          content={'header\nfirst'}
          filePath="same.csv"
          fileId="same-file"
          onContentChange={first}
        />
        <CsvViewer
          content={'header\nfirst'}
          filePath="same.csv"
          fileId="same-file"
          onContentChange={second}
        />
      </>
    )
    fireEvent.doubleClick(screen.getAllByRole('gridcell', { name: 'first' })[0]!)
    fireEvent.change(screen.getByRole('textbox', { name: /Edit row/ }), {
      target: { value: 'pending first pane' }
    })
    expect(hasPendingEditorBufferChange(NO_SHARING, 'same-file')).toBe(true)
    act(() => flushPendingEditorBuffer(NO_SHARING, 'same-file'))
    expect(first).toHaveBeenCalledWith('header\npending first pane')
    expect(second).not.toHaveBeenCalled()
  })
})
