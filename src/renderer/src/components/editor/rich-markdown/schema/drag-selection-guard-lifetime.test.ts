// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { DragSelectionGuard } from './drag-selection-guard'

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
  // Release leaked baseline callbacks when running the regression override.
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
