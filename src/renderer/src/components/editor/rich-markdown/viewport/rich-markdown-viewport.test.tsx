// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRichMarkdownViewport, richMarkdownViewport } from './rich-markdown-viewport'

import { useRichMarkdownSearch } from '../search/useRichMarkdownSearch'
import { useRichMarkdownViewport } from './useRichMarkdownViewport'

vi.mock('@/store/index', () => ({
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
