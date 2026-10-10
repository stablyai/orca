// @vitest-environment happy-dom
import { StrictMode, useLayoutEffect, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ keybindings: {} })
}))

const cleanups: (() => void)[] = []

function mountSearch(content = '<p>beta beta</p><p>Edit here</p>', strict = false) {
  vi.useFakeTimers()
  const editor = new Editor({ extensions: [StarterKit], content })
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const searchBar = document.createElement('div')
  searchBar.className = 'rich-markdown-search'
  const input = document.createElement('input')
  const otherControl = document.createElement('input')
  searchBar.append(input)
  root.append(editor.view.dom, searchBar)
  document.body.append(root, otherControl)
  const scrollContainer = document.createElement('div')
  const rootRef = { current: root }
  const scrollContainerRef = { current: scrollContainer }
  const beforePassiveRef: { current: (() => void) | null } = { current: null }
  const scrollTo = vi.spyOn(scrollContainer, 'scrollTo')
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 20, bottom: 40, left: 0, right: 0 })
  const initialProps: { currentEditor: Editor | null } = { currentEditor: editor }
  const hook = renderHook(
    ({ currentEditor }: { currentEditor: Editor | null }) => {
      const result = useRichMarkdownSearch({ editor: currentEditor, rootRef, scrollContainerRef })
      result.searchState.searchInputRef.current = input
      useLayoutEffect(() => {
        const callback = beforePassiveRef.current
        beforePassiveRef.current = null
        callback?.()
      })
      return result
    },
    {
      initialProps,
      wrapper: strict
        ? ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>
        : undefined
    }
  )
  cleanups.push(() => {
    hook.unmount()
    editor.destroy()
    root.remove()
    otherControl.remove()
  })
  act(() => hook.result.current.openSearch())
  const query = (value: string) => {
    act(() => hook.result.current.searchActions.setSearchQuery(value))
    act(() => vi.advanceTimersByTime(150))
  }
  const selectedText = () =>
    editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to)
  const documentCaret = () => {
    act(() => {
      editor.view.dom.focus({ preventScroll: true })
      editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    })
  }
  return {
    editor,
    root,
    hook,
    input,
    otherControl,
    scrollTo,
    query,
    selectedText,
    documentCaret,
    beforePassiveRef
  }
}

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('rich Markdown search adversarial interactions', () => {
  it('does not revive a delayed search after a document click and another control focus', () => {
    const { editor, hook, otherControl, query, documentCaret, scrollTo } = mountSearch()
    query('beta')
    act(() => hook.result.current.searchActions.setSearchQuery('Edit'))
    documentCaret()
    const selection = editor.state.selection
    act(() => otherControl.focus())
    scrollTo.mockClear()
    act(() => vi.advanceTimersByTime(150))
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(otherControl)
  })

  it('continues typing at the document caret through case and whole-word changes', () => {
    const { editor, hook, query, documentCaret, scrollTo } = mountSearch()
    query('beta')
    documentCaret()
    scrollTo.mockClear()
    act(() => hook.result.current.searchActions.toggleMatchCase())
    act(() => hook.result.current.searchActions.toggleWholeWord())
    act(() => editor.commands.insertContent('XY'))
    expect(editor.getText()).toBe('beta beta\n\nEdit hereXY')
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('lets explicit search navigation select the only match after document editing', () => {
    const { editor, hook, query, documentCaret, selectedText, scrollTo } = mountSearch(
      '<p>beta</p><p>Edit here</p>'
    )
    query('beta')
    documentCaret()
    act(() => editor.commands.insertContent('X'))
    scrollTo.mockClear()
    act(() => hook.result.current.searchActions.moveToMatch(1))
    expect(selectedText()).toBe('beta')
    expect(scrollTo).toHaveBeenCalledOnce()
    expect(editor.isFocused).toBe(true)
  })

  it('advances past replacement text which still contains the search query', () => {
    const { editor, hook, query, selectedText } = mountSearch()
    query('beta')
    act(() => hook.result.current.searchActions.setReplaceQuery('betaX'))
    act(() => hook.result.current.searchActions.replaceCurrentMatch())
    expect(editor.getText()).toBe('betaX beta\n\nEdit here')
    expect(selectedText()).toBe('beta')
    expect(editor.state.selection.from).toBe(7)
    act(() => hook.result.current.searchActions.replaceCurrentMatch())
    expect(editor.getText()).toBe('betaX betaX\n\nEdit here')
  })

  it('does not move the document caret when Replace All retains matching text', () => {
    const { editor, hook, query, documentCaret, scrollTo } = mountSearch()
    query('beta')
    act(() => hook.result.current.searchActions.setReplaceQuery('betaX'))
    documentCaret()
    scrollTo.mockClear()
    act(() => hook.result.current.searchActions.replaceAllMatches())
    expect(editor.getText()).toBe('betaX betaX\n\nEdit here')
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('clamps navigation after external edits remove the active match', () => {
    const { editor, hook, query, selectedText } = mountSearch('<p>beta beta beta</p>')
    query('beta')
    act(() => hook.result.current.searchActions.moveToMatch(1))
    act(() => hook.result.current.searchActions.moveToMatch(1))
    act(() => editor.commands.setContent('<p>beta</p>'))
    expect(hook.result.current.searchState.activeMatchIndex).toBe(0)
    act(() => hook.result.current.searchActions.moveToMatch(1))
    expect(selectedText()).toBe('beta')
  })

  it('keeps decorations fresh without moving selection through batched document edits', () => {
    const { editor, hook, query, documentCaret, scrollTo } = mountSearch()
    query('beta')
    documentCaret()
    scrollTo.mockClear()
    act(() => {
      editor.commands.insertContent(' beta')
      editor.commands.insertContent(' beta')
    })
    expect(hook.result.current.searchState.matchCount).toBe(4)
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    expect(editor.state.selection.empty).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('does not dispatch stale match positions when the document changes before passive effects', () => {
    const { editor, hook, beforePassiveRef } = mountSearch('<p>beta</p><p>target</p>')
    act(() => hook.result.current.searchActions.setSearchQuery('target'))
    beforePassiveRef.current = () => editor.commands.setContent('<p>x</p>')
    expect(() => act(() => vi.advanceTimersByTime(150))).not.toThrow()
    expect(editor.getText()).toBe('x')
    expect(hook.result.current.searchState.matchCount).toBe(0)
  })

  it('cancels a pending query when the input is cleared', () => {
    const { editor, hook, query, scrollTo } = mountSearch()
    query('beta')
    const selection = editor.state.selection
    scrollTo.mockClear()
    act(() => hook.result.current.searchActions.setSearchQuery('Edit'))
    act(() => hook.result.current.searchActions.setSearchQuery(''))
    act(() => vi.advanceTimersByTime(150))
    expect(hook.result.current.searchState.matchCount).toBe(0)
    expect(editor.state.selection.eq(selection)).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('uses refreshed positions when the document changes before search navigation commits', () => {
    const { editor, hook, beforePassiveRef, selectedText, scrollTo } = mountSearch(
      '<p>beta</p><p>target</p>'
    )
    act(() => hook.result.current.searchActions.setSearchQuery('target'))
    beforePassiveRef.current = () => editor.commands.setContent('<p>prefix prefix target</p>')
    scrollTo.mockClear()
    act(() => vi.advanceTimersByTime(150))
    expect(hook.result.current.searchState.matchCount).toBe(1)
    expect(selectedText()).toBe('target')
    expect(editor.state.selection.from).toBe(15)
    expect(scrollTo).toHaveBeenCalledOnce()
  })

  it('moves Next relative to the clamped active match after several matches disappear', () => {
    const { editor, hook, query } = mountSearch('<p>beta beta beta beta beta</p>')
    query('beta')
    for (let index = 0; index < 4; index++) {
      act(() => hook.result.current.searchActions.moveToMatch(1))
    }
    expect(hook.result.current.searchState.activeMatchIndex).toBe(4)
    act(() => editor.commands.setContent('<p>beta beta beta</p>'))
    expect(hook.result.current.searchState.activeMatchIndex).toBe(0)
    act(() => hook.result.current.searchActions.moveToMatch(1))
    expect(hook.result.current.searchState.activeMatchIndex).toBe(1)
    expect(editor.state.selection.from).toBe(6)
  })

  it('does not navigate to an old query when replacing during the debounce window', () => {
    const { editor, hook, query, scrollTo } = mountSearch()
    query('beta')
    act(() => hook.result.current.searchActions.setSearchQuery('Edit'))
    act(() => hook.result.current.searchActions.setReplaceQuery('changed'))
    act(() => editor.commands.setTextSelection(editor.state.doc.content.size - 1))
    scrollTo.mockClear()
    act(() => hook.result.current.searchActions.replaceCurrentMatch())
    expect(editor.getText()).toBe('beta beta\n\nchanged here')
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it('survives strict effect replay, null editor, and a fresh editor instance', () => {
    const { editor, hook, input, query, documentCaret, scrollTo } = mountSearch(undefined, true)
    query('beta')
    documentCaret()
    act(() => editor.commands.insertContent('X'))
    act(() => input.focus())
    act(() => hook.rerender({ currentEditor: null }))
    const replacement = new Editor({ extensions: [StarterKit], content: '<p>beta</p>' })
    vi.spyOn(replacement.view, 'coordsAtPos').mockReturnValue({
      top: 20,
      bottom: 40,
      left: 0,
      right: 0
    })
    scrollTo.mockClear()
    act(() => hook.rerender({ currentEditor: replacement }))
    expect(hook.result.current.searchState.matchCount).toBe(1)
    expect(
      replacement.state.doc.textBetween(
        replacement.state.selection.from,
        replacement.state.selection.to
      )
    ).toBe('beta')
    expect(scrollTo).toHaveBeenCalledOnce()
    act(() => hook.rerender({ currentEditor: null }))
    replacement.destroy()
  })

  it('survives a debounce completing after its editor has been destroyed', () => {
    const { editor, hook } = mountSearch()
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    act(() => editor.destroy())
    expect(() => act(() => vi.advanceTimersByTime(150))).not.toThrow()
  })

  it('does not replay an old Next request into a replacement editor after focus leaves Find', () => {
    const { editor, hook, root, query, documentCaret, scrollTo } = mountSearch()
    query('beta')
    act(() => hook.result.current.searchActions.moveToMatch(1))
    documentCaret()
    act(() => hook.rerender({ currentEditor: null }))
    editor.view.dom.remove()
    const replacement = new Editor({ extensions: [StarterKit], content: '<p>beta</p>' })
    root.prepend(replacement.view.dom)
    vi.spyOn(replacement.view, 'coordsAtPos').mockReturnValue({
      top: 20,
      bottom: 40,
      left: 0,
      right: 0
    })
    scrollTo.mockClear()
    act(() => hook.rerender({ currentEditor: replacement }))
    expect(replacement.state.selection.empty).toBe(true)
    expect(scrollTo).not.toHaveBeenCalled()
    act(() => hook.rerender({ currentEditor: null }))
    replacement.destroy()
  })

  it('survives the editor being destroyed by a selection-update listener', () => {
    const { editor, query } = mountSearch()
    editor.on('selectionUpdate', () => editor.destroy())
    expect(() => query('beta')).not.toThrow()
  })
})
