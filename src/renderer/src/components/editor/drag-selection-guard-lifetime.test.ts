// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { DragSelectionGuard } from './drag-selection-guard'
import { createRichMarkdownSearchPlugin, richMarkdownSearchPluginKey } from './rich-markdown-search'

const editors: Editor[] = []
const hosts: HTMLElement[] = []
const selectionListeners = new Set<EventListenerOrEventListenerObject>()

function createEditor(): Editor {
  const host = document.createElement('div')
  document.body.appendChild(host)
  hosts.push(host)
  const editor = new Editor({
    element: host,
    extensions: [StarterKit, DragSelectionGuard],
    content: '<p>Ordinary text selection</p>',
    autofocus: false
  })
  editors.push(editor)
  return editor
}

beforeEach(() => {
  const add = document.addEventListener.bind(document)
  const remove = document.removeEventListener.bind(document)
  vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'selectionchange' && listener) {
      selectionListeners.add(listener)
    }
    add(type, listener, options)
  })
  vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'selectionchange' && listener) {
      selectionListeners.delete(listener)
    }
    remove(type, listener, options)
  })
})

afterEach(async () => {
  for (const editor of editors.splice(0)) {
    editor.destroy()
  }
  await Promise.resolve()
  // Why: release the original source's leaked callback when running the regression override.
  for (const listener of selectionListeners) {
    document.removeEventListener('selectionchange', listener)
  }
  selectionListeners.clear()
  for (const host of hosts.splice(0)) {
    host.remove()
  }
  vi.restoreAllMocks()
})

describe('drag selection guard listener lifetime', () => {
  it('releases the document listener after the real view finishes destroying', async () => {
    const editor = createEditor()
    const view = editor.view
    const doc = view.state.doc
    expect(selectionListeners.size).toBe(1)

    editor.destroy()
    editor.destroy()
    expect(view.isDestroyed).toBe(true)
    expect(view.state.doc).toBe(doc)
    expect(selectionListeners.size).toBe(1)

    await Promise.resolve()

    expect(selectionListeners.size).toBe(0)
  })

  it('restores selection handling synchronously when the live guard is removed', async () => {
    const editor = createEditor()
    const view = editor.view
    const doc = view.state.doc
    editor.unregisterPlugin('dragSelectionGuard')
    const restored = [...selectionListeners][0]
    expect(restored).toBeDefined()
    expect(selectionListeners.size).toBe(1)
    expect(view.isDestroyed).toBe(false)

    document.dispatchEvent(new Event('selectionchange'))
    expect(view.state.doc).toBe(doc)
    await Promise.resolve()

    expect(selectionListeners.size).toBe(1)
    expect([...selectionListeners][0]).toBe(restored)
    editor.commands.insertContent(' edited')
    expect(editor.getText()).toContain(' edited')
  })

  it('preserves the live listener and document during search reconfiguration', async () => {
    const editor = createEditor()
    const view = editor.view
    const doc = view.state.doc
    for (let pass = 0; pass < 3; pass++) {
      editor.registerPlugin(createRichMarkdownSearchPlugin())
      editor.unregisterPlugin(richMarkdownSearchPluginKey)
      expect(selectionListeners.size).toBe(1)
      await Promise.resolve()
      expect(selectionListeners.size).toBe(1)
      expect(editor.view).toBe(view)
      expect(view.isDestroyed).toBe(false)
      expect(view.state.doc).toBe(doc)
    }
  })

  it('removes the old view listener while preserving an immediately remounted view', async () => {
    const editor = createEditor()
    const oldView = editor.view
    const doc = oldView.state.doc
    editor.unmount()
    const oldListener = [...selectionListeners][0]
    expect(oldListener).toBeDefined()
    expect(oldView.isDestroyed).toBe(true)

    const host = document.createElement('div')
    document.body.appendChild(host)
    hosts.push(host)
    editor.mount(host)
    const newView = editor.view
    expect(newView).not.toBe(oldView)
    expect(newView.state.doc).toBe(doc)
    expect(selectionListeners.size).toBe(2)

    await Promise.resolve()

    expect(selectionListeners.size).toBe(1)
    expect([...selectionListeners][0]).not.toBe(oldListener)
    expect(newView.isDestroyed).toBe(false)
    editor.commands.insertContent(' remounted')
    expect(editor.getText()).toContain(' remounted')
  })
})
