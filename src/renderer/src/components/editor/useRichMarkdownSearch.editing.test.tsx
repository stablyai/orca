// @vitest-environment happy-dom
import { act, fireEvent, render, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'
import { RichMarkdownSearchBar } from './RichMarkdownSearchBar'
import { DragSelectionGuard, richMarkdownSelectionCompletionEvents } from './drag-selection-guard'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

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

function mountClosingSearch() {
  vi.useFakeTimers()
  const editor = new Editor({
    extensions: [StarterKit, DragSelectionGuard],
    content: '<p>beta beta</p><p>Edit here</p>',
    editorProps: { handleDOMEvents: richMarkdownSelectionCompletionEvents }
  })
  const root = document.createElement('div')
  const bar = document.createElement('div')
  const otherPane = document.createElement('input')
  root.append(editor.view.dom, bar)
  document.body.append(root, otherPane)
  const scrollTo = vi.spyOn(root, 'scrollTo')
  vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({ top: 20, bottom: 40, left: 0, right: 0 })
  let current: ReturnType<typeof useRichMarkdownSearch> | null = null
  function Surface({ liveEditor }: { liveEditor: Editor | null }) {
    const result = useRichMarkdownSearch({
      editor: liveEditor,
      rootRef: { current: root },
      scrollContainerRef: { current: root }
    })
    current = result
    const { searchState: s, searchActions: a } = result
    return (
      <RichMarkdownSearchBar
        activeMatchIndex={s.activeMatchIndex}
        isOpen={s.isSearchOpen}
        isReplaceMode={s.isReplaceMode}
        matchCase={s.matchCase}
        matchCount={s.matchCount}
        query={s.searchQuery}
        replaceQuery={s.replaceQuery}
        replaceDisabled={s.replaceDisabled}
        searchInputRef={s.searchInputRef}
        wholeWord={s.wholeWord}
        onClose={a.closeSearch}
        onMoveToMatch={a.moveToMatch}
        onQueryChange={a.setSearchQuery}
        onReplaceAll={a.replaceAllMatches}
        onReplaceCurrent={a.replaceCurrentMatch}
        onReplaceQueryChange={a.setReplaceQuery}
        onToggleMatchCase={a.toggleMatchCase}
        onToggleReplaceMode={a.toggleReplaceMode}
        onToggleWholeWord={a.toggleWholeWord}
      />
    )
  }
  const mounted = render(<Surface liveEditor={editor} />, { container: bar })
  const search = () => {
    if (!current) {
      throw new Error('Expected mounted search')
    }
    return current
  }
  const shortcut = () =>
    fireEvent.keyDown(document.activeElement ?? editor.view.dom, {
      key: 'f',
      code: 'KeyF',
      metaKey: navigator.userAgent.includes('Mac'),
      ctrlKey: !navigator.userAgent.includes('Mac')
    })
  act(() => editor.view.focus())
  shortcut()
  const input = mounted.getByRole('textbox', { name: 'Find in rich markdown editor' })
  fireEvent.change(input, { target: { value: 'beta' } })
  act(() => vi.advanceTimersByTime(150))
  return {
    editor,
    root,
    otherPane,
    mounted,
    setEditor: (liveEditor: Editor | null) => mounted.rerender(<Surface liveEditor={liveEditor} />),
    search,
    shortcut,
    scrollTo,
    input,
    dispose: () => {
      mounted.unmount()
      editor.destroy()
      root.remove()
      otherPane.remove()
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('rich markdown editing with Find open', () => {
  it.each(['Find Escape', 'Replace Escape', 'pointer close', 'keyboard close'])(
    'returns owned focus before unmount for immediate reopen after %s',
    (entry) => {
      const fixture = mountClosingSearch()
      const { editor, mounted, input, shortcut, scrollTo, dispose } = fixture
      try {
        if (entry === 'Replace Escape') {
          fireEvent.click(mounted.getByRole('button', { name: 'Toggle replace' }))
          act(() =>
            mounted.getByRole('textbox', { name: 'Replace in rich markdown editor' }).focus()
          )
        }
        const selection = editor.state.selection
        const focus = editor.view.focus.bind(editor.view)
        const returnFocus = vi.spyOn(editor.view, 'focus').mockImplementation(() => {
          expect(input.isConnected).toBe(true)
          focus()
        })
        scrollTo.mockClear()
        if (entry.endsWith('Escape')) {
          fireEvent.keyDown(document.activeElement ?? input, { key: 'Escape' })
        } else {
          const close = mounted.getByRole('button', { name: 'Close search' })
          if (entry === 'keyboard close') {
            act(() => close.focus())
          } else {
            expect(fireEvent.mouseDown(close, { button: 0 })).toBe(false)
          }
          fireEvent.click(close)
        }
        expect(input.isConnected).toBe(false)
        expect(returnFocus).toHaveBeenCalledOnce()
        expect(document.activeElement).toBe(editor.view.dom)
        expect(editor.state.selection.eq(selection)).toBe(true)
        expect(scrollTo).not.toHaveBeenCalled()
        shortcut()
        expect(document.activeElement).toBe(
          mounted.getByRole('textbox', { name: 'Find in rich markdown editor' })
        )
        expect(fixture.search().searchState.searchQuery).toBe('')
      } finally {
        dispose()
      }
    }
  )

  it.each(['other pane', 'same shell', 'disconnected', 'destroyed', 'null editor'])(
    'closes unconditionally without a focus handoff for %s',
    (owner) => {
      const { editor, root, otherPane, setEditor, search, dispose } = mountClosingSearch()
      const focus = vi.spyOn(editor.view, 'focus')
      try {
        if (owner === 'same shell') {
          root.append(otherPane)
        }
        if (owner === 'other pane' || owner === 'same shell') {
          act(() => otherPane.focus())
        } else if (owner === 'disconnected') {
          editor.view.dom.remove()
        } else if (owner === 'destroyed') {
          editor.destroy()
        } else {
          setEditor(null)
        }
        act(() => search().searchActions.closeSearch())
        expect(focus).not.toHaveBeenCalled()
        expect(search().searchState.isSearchOpen).toBe(false)
        expect(search().searchState.searchQuery).toBe('')
        if (owner === 'other pane' || owner === 'same shell') {
          act(() => vi.runOnlyPendingTimers())
          expect(document.activeElement).toBe(otherPane)
        }
      } finally {
        dispose()
      }
    }
  )

  it.each(['Escape', 'programmatic'])(
    'publishes the focused native range before %s removes active highlights',
    (entry) => {
      const { editor, root, search, scrollTo, dispose } = mountClosingSearch()
      try {
        expect(root.querySelectorAll('.rich-markdown-search-match')).toHaveLength(2)
        act(() => editor.view.focus())
        const text = editor.view.dom.querySelector('p:last-child')?.firstChild
        if (!text) {
          throw new Error('Expected editor text')
        }
        const from = editor.view.posAtDOM(text, 2)
        const to = editor.view.posAtDOM(text, 7)
        const holdSelectionChange = (event: Event) => event.stopImmediatePropagation()
        document.addEventListener('selectionchange', holdSelectionChange, true)
        try {
          // Model a native notification that has not arrived before the next captured key/action.
          document.getSelection()?.setBaseAndExtent(text, 2, text, 7)
        } finally {
          document.removeEventListener('selectionchange', holdSelectionChange, true)
        }
        expect(editor.state.selection.from).not.toBe(from)
        scrollTo.mockClear()
        if (entry === 'Escape') {
          fireEvent.keyDown(editor.view.dom, { key: 'Escape' })
        } else {
          act(() => search().searchActions.closeSearch())
        }
        expect(editor.state.selection.anchor).toBe(from)
        expect(editor.state.selection.head).toBe(to)
        const clipboardData = new DataTransfer()
        editor.view.dom.dispatchEvent(
          new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true })
        )
        expect(clipboardData.getData('text/plain')).toBe('it he')
        act(() => editor.commands.insertContent('X'))
        expect(editor.getText()).toBe('beta beta\n\nEdXre')
        expect(scrollTo).not.toHaveBeenCalled()
      } finally {
        dispose()
      }
    }
  )

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
