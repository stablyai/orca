// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import { usePierreDiffFind } from './use-pierre-diff-find'

const { results } = vi.hoisted(() => ({ results: vi.fn() }))
vi.mock('./use-pierre-diff-search-results', () => ({ usePierreDiffSearchResults: results }))
vi.mock('./use-pierre-diff-search-view', () => ({
  usePierreDiffSearchView: () => ({ onPostRender: vi.fn(), selectActive: vi.fn() })
}))
vi.mock('../editor-shortcuts', () => ({
  editorShortcutMatches: (action: string, event: KeyboardEvent) =>
    event.key === (action === 'editor.find' ? 'f' : 'h') && event.ctrlKey
}))

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  document.body.replaceChildren()
})

function setup(isEditable: boolean) {
  const container = document.createElement('div')
  document.body.append(container)
  const editor = {
    getText: vi.fn(() => 'modified'),
    applyEdits: vi.fn(),
    setSelections: vi.fn(),
    setDeletedTextSelectionActive: vi.fn(),
    focus: vi.fn()
  }
  const fileDiff = { additionLines: ['modified'], deletionLines: ['original'] } as FileDiffMetadata
  const containerRef = { current: container }
  const editorRef = { current: editor } as never
  const { result } = renderHook(() =>
    usePierreDiffFind({
      isEditable,
      containerRef,
      editorRef,
      fileDiff
    })
  )
  const find = (key = 'f') =>
    act(() =>
      result.current.handleContainerKeyDown({
        key,
        nativeEvent: new KeyboardEvent('keydown', { key, ctrlKey: true }),
        ctrlKey: true,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.KeyboardEvent<HTMLElement>)
    )
  return { result, editor, find }
}

it('opens find on the first press without creating a writable read-only session', () => {
  results.mockReturnValue(null)
  const { result, find, editor } = setup(false)
  find()
  expect(result.current.searchBar?.canReplace).toBe(false)
  act(() => result.current.searchBar?.onReplace(true))
  expect(editor.applyEdits).not.toHaveBeenCalled()
  act(() => result.current.searchBar?.onClose())
  expect(result.current.searchBar).toBeNull()
})

it('searches original content and restores its native selection on close', () => {
  results.mockReturnValue(null)
  const { result, find, editor } = setup(true)
  find()
  act(() => result.current.searchBar?.onSide('deletions'))
  expect(results.mock.lastCall?.[0].text).toBe('original')
  expect(result.current.searchBar?.canReplace).toBe(false)
  act(() => result.current.searchBar?.onClose())
  expect(editor.setDeletedTextSelectionActive).toHaveBeenCalledWith(true)
})

it('keeps replace targeting additions after Cmd+H then Cmd+F', () => {
  results.mockReturnValue(null)
  const { result, find } = setup(true)
  const deleted = document.createElement('div')
  deleted.setAttribute('data-code', '')
  deleted.setAttribute('data-deletions', '')
  act(() =>
    result.current.onPointerDown({
      nativeEvent: { composedPath: () => [deleted] }
    } as unknown as React.PointerEvent<HTMLElement>)
  )
  find('h')
  expect(result.current.searchBar?.side).toBe('additions')
  expect(result.current.searchBar?.canReplace).toBe(true)
  expect(result.current.searchBar?.replaceOpen).toBe(true)
  find('f')
  expect(result.current.searchBar?.side).toBe('additions')
  expect(result.current.searchBar?.canReplace).toBe(true)
  expect(results.mock.lastCall?.[0].text).toBe('modified')
})

it('fences replacement against edits made after async search started', () => {
  results.mockReturnValue({
    matches: [
      {
        range: { start: { line: 1, character: 0 }, end: { line: 1, character: 8 } },
        replacement: 'new'
      }
    ],
    truncated: false
  })
  const { result, find, editor } = setup(true)
  find('h')
  expect(result.current.searchBar?.replaceOpen).toBe(true)
  editor.getText.mockReturnValue('newer edit')
  act(() => result.current.searchBar?.onReplace(true))
  expect(editor.applyEdits).not.toHaveBeenCalled()
})

it('moves between results with F3 and Shift+F3', () => {
  const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  results.mockReturnValue({ matches: [{ range }, { range }], truncated: false })
  const { result, find } = setup(false)
  find()
  act(() =>
    result.current.searchBar?.onQuery({
      text: 'm',
      regex: false,
      matchCase: false,
      wholeWord: false
    })
  )
  const key = (shiftKey: boolean) =>
    act(() =>
      result.current.handleContainerKeyDown({
        key: 'F3',
        shiftKey,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn()
      } as unknown as React.KeyboardEvent<HTMLElement>)
    )
  key(false)
  expect(result.current.searchBar?.status).toBe('2/2')
  key(true)
  expect(result.current.searchBar?.status).toBe('1/2')
})
