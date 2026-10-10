// @vitest-environment happy-dom
import { useState } from 'react'
import { renderHook, cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CsvViewer from './CsvViewer'
import { useCsvTableEditor } from './useCsvTableEditor'
import { parseCsvTextDocument } from './csv-text-document'
import { flushPendingEditorChange, hasPendingEditorChange } from '../editor-pending-flush'
import { APP_MENU_PASTE_EVENT } from '@/lib/app-menu-paste'
import { ORCA_EDITOR_FILE_SAVED_EVENT } from '../editor-autosave'

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

  it('flushes the active input into the draft for global Save and hot exit', () => {
    const { changes } = setup()
    edit('B', 'pending')
    act(() => flushPendingEditorChange('csv-edit-test'))
    expect(changes).toHaveBeenCalledWith('\ufeffname,value\r\npending,2\r\nA,1')
  })

  it('retains pending input when switching away from the table', () => {
    const { changes, unmount } = setup()
    edit('B', 'switching')
    unmount()
    expect(changes).toHaveBeenCalledWith('\ufeffname,value\r\nswitching,2\r\nA,1')
  })

  it('saves the current cell value and reports a failed write without dropping the draft', async () => {
    const { save } = setup()
    save.mockResolvedValue(false)
    fireEvent.keyDown(edit('B', 'saved value'), { key: 's', ctrlKey: true, metaKey: true })
    expect(save).toHaveBeenCalledWith('\ufeffname,value\r\nsaved value,2\r\nA,1')
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Your edits remain in the draft'
    )
    expect(screen.getByTestId('source').textContent).toContain('saved value')
  })

  it('pastes atomically into selected cells and does not partially apply an oversized rectangle', () => {
    const { changes } = setup()
    const cell = screen.getByRole('gridcell', { name: 'B' })
    fireEvent.pointerDown(cell, { button: 0 })
    const grid = screen.getByRole('grid')
    fireEvent.paste(grid, { clipboardData: { getData: () => 'new\t3\nother\t4' } })
    expect(screen.getByTestId('source').textContent).toBe('\ufeffname,value\r\nnew,3\r\nother,4')
    fireEvent.paste(grid, { clipboardData: { getData: () => 'one\ttwo\tthree' } })
    expect(changes).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('alert').textContent).toContain('Paste exceeds the table')
  })

  it('edits a filtered row in its original source position', () => {
    setup()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter rows' }), {
      target: { value: 'A' }
    })
    fireEvent.keyDown(edit('1', 'updated'), { key: 'Enter' })
    expect(screen.getByTestId('source').textContent).toBe('\ufeffname,value\r\nB,2\r\nA,updated')
  })

  it('keeps the chosen table delimiter when an edit would change the Auto guess', () => {
    setup('first;second\nvalue;two')
    fireEvent.doubleClick(screen.getByRole('columnheader', { name: 'first' }))
    const input = screen.getByRole('textbox', { name: /Edit row/ })
    fireEvent.change(input, { target: { value: 'tabs\there\ttoo' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(screen.getByRole('grid').getAttribute('aria-colcount')).toBe('3')
    expect(screen.getByRole('columnheader', { name: 'tabs\there\ttoo' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Delimiter' }).textContent).toBe('Semicolon (;)')
  })

  it('cancels only the new cell after an earlier save completes', () => {
    setup()
    fireEvent.keyDown(edit('B', 'saved base'), { key: 'Enter' })
    const source = screen.getByTestId('source').textContent
    const input = edit('A', 'new pending cell')
    expect(hasPendingEditorChange('csv-edit-test')).toBe(true)
    act(() =>
      window.dispatchEvent(
        new CustomEvent(ORCA_EDITOR_FILE_SAVED_EVENT, {
          detail: { fileId: 'csv-edit-test', content: source }
        })
      )
    )
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(hasPendingEditorChange('csv-edit-test')).toBe(false)
    expect(screen.getByTestId('dirty').textContent).toBe('false')
    expect(screen.getByTestId('source').textContent).toBe(source)
  })

  it('keeps a rejected over-limit edit visible and recoverable on view detachment', () => {
    const { changes, unmount } = setup()
    const value = 'x'.repeat(1024 * 1024 + 1)
    fireEvent.keyDown(edit('B', value), { key: 'Enter' })
    expect(screen.getByRole('alert').textContent).toContain('record is too large')
    expect(changes).not.toHaveBeenCalled()
    const retained = screen.getByRole('textbox', { name: /Edit row/ })
    expect(retained instanceof HTMLTextAreaElement && retained.value).toBe(value)
    unmount()
    expect(changes).toHaveBeenCalledWith(`\ufeffname,value\r\n${value},2\r\nA,1`)
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

  it('leaves a read-only table without mutation controls or an input', () => {
    render(<CsvViewer content={'a,b\nx,y'} filePath="readonly.csv" />)
    fireEvent.doubleClick(screen.getByRole('cell', { name: 'x' }))
    expect(screen.queryByRole('grid')).toBeNull()
    expect(screen.queryByRole('textbox', { name: /Edit row/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
  })

  it('rejects an asynchronous paste when the selection changes while reading', async () => {
    let resolveRead: (value: string) => void = () => {
      throw new Error('read not initialized')
    }
    const pending = new Promise<string>((resolve) => {
      resolveRead = resolve
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { readClipboardText: () => pending } }
    })
    const { changes } = setup()
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'B' }), { button: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'A' }), { button: 0 })
    await act(async () => {
      resolveRead('stale paste')
      await pending
    })
    expect(changes).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('CSV changed before paste completed')
  })

  it('rejects a delayed paste if typing starts before the clipboard read completes', async () => {
    let resolveRead: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      resolveRead = resolve
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { readClipboardText: () => pending } }
    })
    const { changes } = setup()
    fireEvent.pointerDown(screen.getByRole('gridcell', { name: 'B' }), { button: 0 })
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    edit('B', 'new pending input')
    await act(async () => {
      resolveRead('old clipboard')
      await pending
    })
    expect(changes).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('CSV changed before paste completed')
    const retained = screen.getByRole('textbox', { name: /Edit row/ })
    expect(retained instanceof HTMLTextAreaElement && retained.value).toBe('new pending input')
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
    expect(hasPendingEditorChange('same-file')).toBe(true)
    act(() => flushPendingEditorChange('same-file'))
    expect(first).toHaveBeenCalledWith('header\npending first pane')
    expect(second).not.toHaveBeenCalled()
  })
})
