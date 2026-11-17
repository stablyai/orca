// @vitest-environment happy-dom
import { act, renderHook, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { parseDiffFromFile } from '@pierre/diffs'
import { usePierreDiffFind } from './use-pierre-diff-find'

const { results } = vi.hoisted(() => ({ results: vi.fn() }))
vi.mock('./use-pierre-diff-search-results', () => ({ usePierreDiffSearchResults: results }))
vi.mock('./use-pierre-diff-search-view', () => ({
  usePierreDiffSearchView: () => ({ onPostRender: vi.fn(), selectActive: vi.fn() })
}))
vi.mock('@/components/editor/commands/editor-shortcuts', () => ({
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
  const fileDiff = parseDiffFromFile(
    { name: 'file', contents: 'original' },
    { name: 'file', contents: 'modified' }
  )
  const containerRef = { current: container }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook receives only the editor or event methods supplied at the exercised seam.
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook receives only the editor or event methods supplied at the exercised seam.
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
  act(() =>
    result.current.searchBar?.onQuery({
      text: 'original',
      regex: false,
      wholeWord: false,
      matchCase: false
    })
  )
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
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook receives only the editor or event methods supplied at the exercised seam.
    result.current.onPointerDown({
      nativeEvent: { composedPath: () => [deleted] }
    } as unknown as React.PointerEvent<HTMLElement>)
  )
  find('h')
  act(() =>
    result.current.searchBar?.onQuery({
      text: 'modified',
      regex: false,
      wholeWord: false,
      matchCase: false
    })
  )
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
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook receives only the editor or event methods supplied at the exercised seam.
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

it('preserves the user caret and active match when typing or changing replacement text', () => {
  const first = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
  const second = { start: { line: 3, character: 0 }, end: { line: 3, character: 1 } }
  results.mockReturnValue({ matches: [{ range: first }, { range: second }], truncated: false })
  const { result, editor, find } = setup(true)
  find()
  act(() =>
    result.current.searchBar?.onQuery({
      text: 'm',
      regex: false,
      wholeWord: false,
      matchCase: false
    })
  )
  act(() => result.current.searchBar?.onNavigate(1))
  act(() => result.current.searchBar?.onReplacement('new'))
  expect(result.current.searchBar?.status).toBe('2/2')
  const caret = { start: { line: 200, character: 2 }, end: { line: 200, character: 2 } }
  editor.setSelections([caret])
  editor.getText.mockReturnValue('updated')
  results.mockReturnValue({
    matches: [{ range: first }, { range: { ...second } }],
    truncated: false
  })
  act(() => result.current.onEditChange())
  expect(editor.setSelections.mock.lastCall?.[0]).toEqual([caret])
  expect(result.current.searchBar?.status).toBe('2/2')
})
