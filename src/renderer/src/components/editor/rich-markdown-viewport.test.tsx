// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  attachRichMarkdownViewport,
  handleRichMarkdownViewportReveal,
  richMarkdownViewport,
  scrollRichMarkdownElementIntoView
} from './rich-markdown-viewport'
import { useRichMarkdownReviewRailController } from './useRichMarkdownReviewRailController'
import { useRichMarkdownSearch } from './useRichMarkdownSearch'
import { useRichMarkdownViewport } from './useRichMarkdownViewport'

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) => select({ keybindings: {} })
}))

const cleanups: (() => void)[] = []
function fixture() {
  vi.useFakeTimers()
  const editor = new Editor({ extensions: [StarterKit], content: '<p>beta</p><p>beta</p>' })
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const container = document.createElement('div')
  const input = document.createElement('input')
  const search = document.createElement('div')
  search.className = 'rich-markdown-search'
  search.append(input)
  container.append(editor.view.dom)
  root.append(container, search)
  document.body.append(root)
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, value: 5000 },
    clientHeight: { configurable: true, value: 300 }
  })
  vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 300))
  // Annotated because the spy's type takes the (x, y) overload; the editor code passes options.
  const scroll = vi
    .spyOn(container, 'scrollTo')
    .mockImplementation((options?: ScrollToOptions | number) => {
      if (typeof options !== 'object') {
        throw new Error('Expected scroll options')
      }
      container.scrollTop = Math.max(0, Math.min(options.top ?? container.scrollTop, 4700))
      container.scrollLeft = options.left ?? container.scrollLeft
    })
  let target = 800
  vi.spyOn(editor.view, 'coordsAtPos').mockImplementation(() => ({
    top: target - container.scrollTop + 150,
    bottom: 40,
    left: 0,
    right: 0
  }))
  // Spy on the prototype so the editor DOM has no own focus property before attach, as in production.
  const native = HTMLElement.prototype.focus
  const focus = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (
    this: HTMLElement,
    options
  ) {
    if (this === editor.view.dom && !options?.preventScroll) {
      container.scrollTop = 0
    }
    native.call(this, options)
  })
  const rootRef = { current: root }
  const containerRef = { current: container }
  const hook = renderHook(() =>
    useRichMarkdownSearch({
      editor,
      rootRef,
      scrollContainerRef: containerRef
    })
  )
  hook.result.current.searchState.searchInputRef.current = input
  const retire = attachRichMarkdownViewport(editor, root, container)
  act(() => hook.result.current.openSearch())
  act(() => hook.result.current.searchActions.setSearchQuery('beta'))
  act(() => vi.advanceTimersByTime(150))
  const navigate = (top: number) => {
    target = top
    act(() => hook.result.current.searchActions.moveToMatch(1))
  }
  const nativeReturn = (between?: () => void, reset = true, source: HTMLElement = input) => {
    source.dispatchEvent(
      new FocusEvent('focusout', { bubbles: true, relatedTarget: editor.view.dom })
    )
    between?.()
    if (reset) {
      container.scrollTop = 0
    }
    editor.view.dom.dispatchEvent(new FocusEvent('focus', { relatedTarget: source }))
  }
  cleanups.push(() => {
    retire()
    hook.unmount()
    editor.destroy()
    root.remove()
  })
  return {
    editor,
    root,
    container,
    input,
    hook,
    navigate,
    nativeReturn,
    scroll,
    focus,
    retire
  }
}

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('rich Markdown live viewport', () => {
  it.each([0, 1300])(
    'keeps real Find navigation to %i before scroll delivery and during a native handoff',
    (top) => {
      const f = fixture()
      f.container.scrollTop = 1985
      f.navigate(top)
      f.nativeReturn()
      expect(f.container.scrollTop).toBe(top)
      const selection = f.editor.state.selection

      f.container.scrollTop = 1985
      f.nativeReturn(() => f.navigate(top))
      expect(f.container.scrollTop).toBe(top)
      expect(f.editor.state.selection.from).not.toBe(selection.from)
      expect(f.editor.state.doc.textContent).toBe('betabeta')

      // A wheel over the editor's own scroller is user movement, so the reset is not undone.
      f.container.scrollTop = 1985
      f.nativeReturn(() => f.container.dispatchEvent(new WheelEvent('wheel', { bubbles: true })))
      expect(f.container.scrollTop).toBe(0)
    }
  )

  it('prevents exact bare focus after focused-control removal and passes supplied options through unchanged', () => {
    const f = fixture()
    f.input.focus()
    f.input.remove()
    f.container.scrollTop = 1985
    f.editor.view.dom.focus()
    expect(f.container.scrollTop).toBe(1985)
    expect(f.focus).toHaveBeenLastCalledWith({ preventScroll: true })
    const getter = vi.fn(() => true)
    const options = {
      get preventScroll() {
        return getter()
      }
    }
    f.editor.view.dom.focus(options)
    expect(f.focus.mock.calls.at(-1)?.[0]).toBe(options)
    expect(getter).toHaveBeenCalled()
    expect(f.editor.state.doc.textContent).toBe('betabeta')
  })

  it('keeps the current native navigation source through reentrant prevented focus', () => {
    const f = fixture()
    f.container.scrollTop = 1985
    f.nativeReturn(() => {
      f.navigate(0)
      f.editor.view.dom.focus()
    })
    // The nested method consumes the outer handoff; it cannot be replayed on a later unpaired event.
    expect(f.container.scrollTop).toBe(0)
    f.navigate(900)
    f.editor.view.dom.dispatchEvent(new FocusEvent('focus', { relatedTarget: f.input }))
    expect(f.container.scrollTop).toBe(900)
  })

  it('observes a real explicit engine writer while handling only passive recovery', () => {
    const f = fixture()
    f.editor.view.focus()
    f.container.scrollTop = 1985
    f.editor.setOptions({
      editorProps: {
        handleScrollToSelection: () => {
          f.container.scrollTop = 777
          return true
        }
      }
    })
    f.nativeReturn(() => f.editor.view.dispatch(f.editor.state.tr.scrollIntoView()))
    expect(f.container.scrollTop).toBe(777)
    expect(handleRichMarkdownViewportReveal(f.editor.view, 'focus')).toBe(true)
    expect(handleRichMarkdownViewportReveal(f.editor.view)).toBe(false)
    f.retire()
    expect(handleRichMarkdownViewportReveal(f.editor.view, 'focus')).toBe(false)
  })

  it('samples a body-origin Tab before reset without waiting for a scroll event', () => {
    const f = fixture()
    f.input.focus()
    f.input.remove()
    f.container.scrollTop = 1985
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    f.navigate(0)
    f.container.scrollTop = 1551
    f.editor.view.dom.dispatchEvent(new FocusEvent('focus', { relatedTarget: null }))
    expect(f.container.scrollTop).toBe(0)
    expect(f.editor.state.doc.textContent).toBe('betabeta')
  })

  it.each([true, false])(
    'keeps the cancel point without resuming the real smooth anchor writer (reset=%s)',
    (reset) => {
      const f = fixture()
      const heading = document.createElement('h2')
      f.editor.view.dom.append(heading)
      const headingTop = 1700
      vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(
        () => new DOMRect(0, headingTop - f.container.scrollTop, 200, 30)
      )
      const anchor = vi.spyOn(heading, 'scrollIntoView').mockImplementation(() => {})
      scrollRichMarkdownElementIntoView(heading, { block: 'start', behavior: 'smooth' })
      f.container.scrollTop = 600
      f.nativeReturn(undefined, reset)
      expect(f.container.scrollTop).toBe(600)
      expect(anchor).toHaveBeenCalledTimes(1)
      // Completion and later returns cannot replay the interrupted request.
      f.container.dispatchEvent(new Event('scrollend'))
      f.nativeReturn(undefined, reset)
      expect(anchor).toHaveBeenCalledTimes(1)
      f.navigate(0)
      f.nativeReturn()
      expect(anchor).toHaveBeenCalledTimes(1)
      expect(f.container.scrollTop).toBe(0)

      scrollRichMarkdownElementIntoView(heading, { block: 'start', behavior: 'smooth' })
      const control = document.createElement('button')
      f.container.append(control)
      f.container.scrollTop = 700
      control.focus()
      const controlTop = f.container.scrollTop
      f.nativeReturn(undefined, reset, control)
      expect(anchor).toHaveBeenCalledTimes(2)
      expect(f.container.scrollTop).toBe(controlTop)
    }
  )

  it('passes routed writes through exactly while the owner is live and drops them once it is stale or retired', () => {
    const f = fixture()
    const card = document.createElement('div')
    card.dataset.richMarkdownReviewNoteId = 'note'
    f.container.append(card)
    const loose = document.createElement('div')
    document.body.append(loose)
    const reveal = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
    const options: ScrollIntoViewOptions = { block: 'center', behavior: 'smooth' }
    scrollRichMarkdownElementIntoView(card, options)
    scrollRichMarkdownElementIntoView(loose, options)
    expect(reveal.mock.contexts).toEqual([card, loose])
    expect(reveal.mock.calls.map(([passed]) => passed === options)).toEqual([true, true])
    loose.remove()
    // An owner whose editor has left the container drops writes instead of scrolling for it.
    f.root.append(f.editor.view.dom)
    reveal.mockClear()
    scrollRichMarkdownElementIntoView(card, options)
    expect(reveal).not.toHaveBeenCalled()
    f.container.prepend(f.editor.view.dom)

    const rail = renderHook(() =>
      useRichMarkdownReviewRailController({
        canAnnotateRichMarkdown: true,
        content: '',
        editorRef: { current: f.editor },
        markdownComments: [],
        markdownSourceLineOffset: 0,
        markdownSourceLineOffsetRef: { current: 0 },
        scrollContainerRef: { current: f.container }
      })
    )
    const writes = f.scroll.mock.calls.length
    act(() => rail.result.current.scrollRichMarkdownReviewNoteCardIntoView('note'))
    act(() => vi.advanceTimersByTime(40))
    expect(f.scroll).toHaveBeenCalledTimes(writes + 1)
    act(() => rail.result.current.scrollRichMarkdownReviewNoteCardIntoView('note'))
    f.retire()
    act(() => vi.advanceTimersByTime(40))
    expect(f.scroll).toHaveBeenCalledTimes(writes + 1)
    rail.unmount()
  })

  it('retires actual key/container ownership, removes its focus wrapper and cancels owned frames', () => {
    const f = fixture()
    expect(Object.hasOwn(f.editor.view.dom, 'focus')).toBe(true)
    f.retire()
    expect(Object.hasOwn(f.editor.view.dom, 'focus')).toBe(false)
    const rootRef = { current: f.root }
    const containerRef = { current: f.container }
    const lifetime = renderHook(
      ({ key }) => useRichMarkdownViewport(f.editor, key, rootRef, containerRef),
      { initialProps: { key: 'one' } }
    )
    act(() => {
      lifetime.result.current.bindRoot(f.root)
      lifetime.result.current.bindContainer(f.container)
    })
    const lease = richMarkdownViewport(f.container)
    const frame = vi.fn()
    lease.frame(frame)
    lifetime.rerender({ key: 'two' })
    expect(lease.current()).toBe(false)
    act(() => vi.advanceTimersByTime(30))
    expect(frame).not.toHaveBeenCalled()
    const current = richMarkdownViewport(f.container)
    act(() => lifetime.result.current.bindContainer(null))
    expect(current.current()).toBe(false)
    expect(Object.hasOwn(f.editor.view.dom, 'focus')).toBe(false)
    const calls = f.scroll.mock.calls.length
    lease.scroll(() => f.container.scrollTo({ top: 1 }))
    expect(f.scroll).toHaveBeenCalledTimes(calls)
    lifetime.unmount()
  })
})
