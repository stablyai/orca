// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ keybindings: {} })
}))

function mountSearch() {
  const editor = new Editor({
    extensions: [StarterKit],
    content: '<p>beta beta</p><p>Edit here</p>'
  })
  const scrollContainer = document.createElement('div')
  const scrollTo = vi.spyOn(scrollContainer, 'scrollTo')
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 20, bottom: 40, left: 0, right: 0 })
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  const input = document.createElement('input')
  search.append(input)
  root.append(editor.view.dom)
  root.append(search)
  document.body.append(root)
  const hook = renderHook(() => {
    const result = useRichMarkdownSearch({
      editor,
      rootRef: { current: root },
      scrollContainerRef: { current: scrollContainer }
    })
    result.searchState.searchInputRef.current = input
    return result
  })
  act(() => hook.result.current.openSearch())
  act(() => hook.result.current.searchActions.setSearchQuery('beta'))
  act(() => vi.advanceTimersByTime(150))
  const dispose = () => {
    hook.unmount()
    editor.destroy()
    root.remove()
  }
  return { editor, hook, scrollTo, dispose }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('rich markdown editing with Find open', () => {
  it('updates highlights without moving the typing caret or scrolling to a match', () => {
    vi.useFakeTimers()
    const { editor, hook, scrollTo, dispose } = mountSearch()
    try {
      const insertion = editor.state.doc.content.size - 1
      act(() => editor.commands.setTextSelection(insertion))
      scrollTo.mockClear()
      act(() => editor.commands.insertContent('X'))
      act(() => editor.commands.insertContent('Y'))
      expect(editor.getText()).toBe('beta beta\n\nEdit hereXY')
      expect(editor.state.selection.from).toBe(insertion + 2)
      expect(editor.state.selection.empty).toBe(true)
      expect(hook.result.current.searchState.matchCount).toBe(2)
      expect(hook.result.current.searchState.isSearchOpen).toBe(true)
      expect(scrollTo).not.toHaveBeenCalled()
      act(() => editor.commands.undo())
      expect(editor.getText()).toBe('beta beta\n\nEdit here')
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('preserves selection when edits remove every match and later restore one', () => {
    vi.useFakeTimers()
    const { editor, hook, scrollTo, dispose } = mountSearch()
    try {
      scrollTo.mockClear()
      act(() => editor.commands.setContent('<p>No results</p><p>End</p>'))
      expect(hook.result.current.searchState.matchCount).toBe(0)
      act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
      act(() => editor.commands.insertContent(' beta'))
      expect(hook.result.current.searchState.matchCount).toBe(1)
      expect(editor.state.selection.empty).toBe(true)
      expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })

  it('still navigates on Next with only one match, and advances after Replace', () => {
    vi.useFakeTimers()
    const { editor, hook, scrollTo, dispose } = mountSearch()
    try {
      act(() => hook.result.current.searchActions.setReplaceQuery('changed'))
      act(() => hook.result.current.searchActions.replaceCurrentMatch())
      expect(editor.getText()).toBe('changed beta\n\nEdit here')
      expect(hook.result.current.searchState.matchCount).toBe(1)
      expect(
        editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
      ).toBe('beta')
      act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
      scrollTo.mockClear()
      act(() => hook.result.current.searchActions.moveToMatch(1))
      expect(
        editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
      ).toBe('beta')
      expect(scrollTo).toHaveBeenCalledOnce()
    } finally {
      dispose()
    }
  })

  it('does not apply delayed search navigation after focus returns to the document', () => {
    vi.useFakeTimers()
    const { editor, hook, scrollTo, dispose } = mountSearch()
    try {
      act(() => hook.result.current.searchActions.setSearchQuery('Edit'))
      act(() => {
        editor.view.dom.focus({ preventScroll: true })
        editor.commands.setTextSelection(editor.state.doc.content.size - 1)
      })
      expect(editor.isFocused).toBe(true)
      const selection = editor.state.selection
      scrollTo.mockClear()
      act(() => vi.advanceTimersByTime(150))
      expect(hook.result.current.searchState.matchCount).toBe(1)
      expect(editor.state.selection.eq(selection)).toBe(true)
      expect(scrollTo).not.toHaveBeenCalled()
    } finally {
      dispose()
    }
  })
})
