// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Schema, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'
import type { Editor } from '@tiptap/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as visibleText from './rich-markdown-visible-text-map'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ keybindings: {} })
}))

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'inline*' },
    text: { group: 'inline' },
    atom: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { label: {} },
      leafText: (node) => node.attrs.label
    }
  }
})

function createDoc(atomLabel = 'locked') {
  return schema.node(
    'doc',
    null,
    schema.node('paragraph', null, [
      schema.text('beta beta '),
      schema.node('atom', { label: atomLabel })
    ])
  )
}

function mountSearch() {
  let state = EditorState.create({ doc: createDoc() })
  const listeners = new Set<() => void>()
  const editor = {
    get state() {
      return state
    },
    commands: { focus: vi.fn() },
    on: (_event: string, listener: () => void) => listeners.add(listener),
    off: (_event: string, listener: () => void) => listeners.delete(listener),
    registerPlugin: vi.fn(),
    unregisterPlugin: vi.fn(),
    view: {
      dispatch: (tr: EditorState['tr']) => {
        state = state.apply(tr)
        if (tr.docChanged) {
          listeners.forEach((listener) => listener())
        }
      }
    }
  } as unknown as Editor
  const hook = renderHook(() =>
    useRichMarkdownSearch({
      editor,
      rootRef: { current: null },
      scrollContainerRef: { current: null }
    })
  )
  return {
    hook,
    editor,
    replaceDocSilently: (doc: ProseMirrorNode) => {
      state = EditorState.create({ doc })
    }
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('live rich markdown search reuse', () => {
  it('does not rescan while typing replacement text, navigating, or publishing debounced highlights', () => {
    vi.useFakeTimers()
    const walk = vi.spyOn(visibleText, 'createRichMarkdownVisibleTextMap')
    const { hook } = mountSearch()
    act(() => hook.result.current.openSearch())
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    expect(walk).toHaveBeenCalledTimes(1)
    act(() => vi.advanceTimersByTime(150))
    expect(hook.result.current.searchState.matchCount).toBe(2)
    for (let index = 0; index < 20; index++) {
      act(() => hook.result.current.searchActions.setReplaceQuery(`replacement ${index}`))
      act(() => hook.result.current.searchActions.moveToMatch(1))
    }
    expect(walk).toHaveBeenCalledTimes(1)
    act(() => hook.result.current.searchActions.closeSearch())
    act(() => hook.result.current.openSearch())
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    expect(walk).toHaveBeenCalledTimes(2)
    hook.unmount()
  })

  it('uses the immediate query for atom guards and replacements during the debounce window', () => {
    vi.useFakeTimers()
    const { hook, editor } = mountSearch()
    act(() => hook.result.current.openSearch())
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    act(() => vi.advanceTimersByTime(150))
    act(() => hook.result.current.searchActions.setSearchQuery('locked'))
    expect(hook.result.current.searchState.matchCount).toBe(2)
    expect(hook.result.current.searchState.replaceDisabled).toBe(true)
    const doc = editor.state.doc
    act(() => hook.result.current.searchActions.replaceAllMatches())
    expect(editor.state.doc).toBe(doc)
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    act(() => hook.result.current.searchActions.setReplaceQuery('changed'))
    act(() => hook.result.current.searchActions.replaceAllMatches())
    expect(editor.state.doc.textContent).toBe('changed changed locked')
    hook.unmount()
  })

  it('checks the latest document even before an editor update reaches React', () => {
    vi.useFakeTimers()
    const { hook, editor, replaceDocSilently } = mountSearch()
    act(() => hook.result.current.openSearch())
    act(() => hook.result.current.searchActions.setSearchQuery('beta'))
    act(() => vi.advanceTimersByTime(150))
    replaceDocSilently(createDoc('beta'))
    const doc = editor.state.doc
    act(() => hook.result.current.searchActions.replaceCurrentMatch())
    expect(editor.state.doc).toBe(doc)
    hook.unmount()
  })
})
