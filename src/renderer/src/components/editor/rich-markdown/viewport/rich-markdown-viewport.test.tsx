// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachRichMarkdownViewport, richMarkdownViewport } from './rich-markdown-viewport'

import { useRichMarkdownViewport } from './useRichMarkdownViewport'

const cleanups: (() => void)[] = []
function fixture() {
  vi.useFakeTimers()
  const editor = new Editor({ extensions: [StarterKit], content: '<p>beta</p><p>beta</p>' })
  const root = document.createElement('div')
  root.className = 'rich-markdown-editor-shell'
  const container = document.createElement('div')
  container.append(editor.view.dom)
  root.append(container)
  document.body.append(root)
  const retire = attachRichMarkdownViewport(editor, root, container)
  cleanups.push(() => {
    retire()
    editor.destroy()
    root.remove()
  })
  return { editor, root, container, retire }
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
    lifetime.unmount()
  })
})
