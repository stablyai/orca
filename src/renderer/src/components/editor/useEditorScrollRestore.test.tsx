// @vitest-environment happy-dom
import React from 'react'
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AllSelection } from '@tiptap/pm/state'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { richMarkdownSelectionCache, scrollTopCache } from '@/lib/scroll-cache'
import { useEditorScrollRestore } from './useEditorScrollRestore'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

const editors: Editor[] = []
function createEditor(text = 'Selection persists across tab switches.') {
  const editor = new Editor({ extensions: [StarterKit], content: `<p>${text}</p>` })
  editors.push(editor)
  return editor
}
function renderRestore(editor: Editor | null, key = 'file.md::tab-a:rich') {
  const container = document.createElement('div')
  return renderHook(
    ({ nextEditor }) => useEditorScrollRestore({ current: container }, key, nextEditor),
    {
      initialProps: { nextEditor: editor }
    }
  )
}

beforeEach(() => {
  richMarkdownSelectionCache.clear()
  scrollTopCache.clear()
})
afterEach(() => {
  vi.unstubAllGlobals()
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('useEditorScrollRestore rich selections', () => {
  it.each([4, { from: 4, to: 12 }, { from: 12, to: 4 }])(
    'restores cursor and directional range %j',
    (selection) => {
      const original = createEditor()
      const mounted = renderRestore(original)
      original.commands.setTextSelection(selection)
      const { anchor, head } = original.state.selection
      mounted.unmount()
      original.destroy()
      const replacement = createEditor()
      const remounted = renderRestore(replacement)
      expect(replacement.state.selection.anchor).toBe(anchor)
      expect(replacement.state.selection.head).toBe(head)
      remounted.unmount()
    }
  )

  it('waits for the editor instance and keeps split siblings separate', () => {
    richMarkdownSelectionCache.set('file.md::tab-a:rich', { from: 4, to: 12 })
    richMarkdownSelectionCache.set('file.md::tab-b:rich', { from: 17, to: 21 })
    const mounted = renderRestore(null)
    const editor = createEditor()
    mounted.rerender({ nextEditor: editor })
    expect(editor.state.selection.anchor).toBe(4)
    expect(editor.state.selection.head).toBe(12)
    const sibling = createEditor()
    const siblingHook = renderRestore(sibling, 'file.md::tab-b:rich')
    expect(sibling.state.selection.anchor).toBe(17)
    expect(sibling.state.selection.head).toBe(21)
    mounted.unmount()
    siblingHook.unmount()
  })

  it('uses the existing Tiptap clamp when file contents shrink', () => {
    richMarkdownSelectionCache.set('file.md::tab-a:rich', { from: 12, to: 1000 })
    const editor = createEditor('short')
    const mounted = renderRestore(editor)
    expect(editor.state.selection.anchor).toBe(6)
    expect(editor.state.selection.head).toBe(6)
    mounted.unmount()
  })

  it('preserves the restored range through deferred mount focus', () => {
    let frame: FrameRequestCallback = () => {}
    const editor = createEditor()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 9
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    richMarkdownSelectionCache.set('file.md::tab-a:rich', { from: 4, to: 12 })
    autoFocusRichEditor(editor, null)
    const mounted = renderRestore(editor)
    frame(0)
    expect(editor.state.selection.anchor).toBe(4)
    expect(editor.state.selection.head).toBe(12)
    mounted.unmount()
  })

  it('does not replace a text cache with a non-text or destroyed selection', () => {
    richMarkdownSelectionCache.set('file.md::tab-a:rich', { from: 4, to: 12 })
    const editor = createEditor()
    const mounted = renderRestore(editor)
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    mounted.unmount()
    expect(richMarkdownSelectionCache.size).toBe(0)
    const destroyed = createEditor()
    const destroyedHook = renderRestore(destroyed)
    destroyed.destroy()
    destroyedHook.unmount()
    expect(richMarkdownSelectionCache.size).toBe(0)
  })

  it('keeps the existing bounded working set across many files', () => {
    for (let index = 0; index < 25; index++) {
      const mounted = renderRestore(createEditor(), `file-${index}.md:rich`)
      mounted.unmount()
    }
    expect(richMarkdownSelectionCache.size).toBe(20)
    expect(richMarkdownSelectionCache.has('file-0.md:rich')).toBe(false)
    expect(richMarkdownSelectionCache.has('file-24.md:rich')).toBe(true)
  })

  it('survives StrictMode layout replay with a cached range', () => {
    richMarkdownSelectionCache.set('file.md::tab-a:rich', { from: 4, to: 12 })
    const editor = createEditor()
    const container = document.createElement('div')
    const mounted = renderHook(
      () => useEditorScrollRestore({ current: container }, 'file.md::tab-a:rich', editor),
      {
        wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>
      }
    )
    expect(editor.state.selection.anchor).toBe(4)
    expect(editor.state.selection.head).toBe(12)
    mounted.unmount()
  })
})
