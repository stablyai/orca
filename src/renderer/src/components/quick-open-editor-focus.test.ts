// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeQuickOpenEditorHandoff, focusOpenedEditorSurface } from './quick-open-editor-focus'

afterEach(() => {
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

function mountEditor(fileId: string, worktreeId: string): HTMLTextAreaElement {
  const panel = document.createElement('div')
  panel.dataset.editorFileId = fileId
  panel.dataset.editorWorktreeId = worktreeId
  const wrapper = document.createElement('div')
  wrapper.className = 'monaco-editor'
  const editor = document.createElement('textarea')
  wrapper.append(editor)
  panel.append(wrapper)
  document.body.append(panel)
  return editor
}

describe('focusOpenedEditorSurface', () => {
  it('focuses the editor for the opened file, not the first mounted editor', () => {
    const other = mountEditor('other-file', 'wt')
    const opened = mountEditor('opened-file', 'wt')
    other.focus()

    expect(focusOpenedEditorSurface({ fileId: 'opened-file', worktreeId: 'wt' })).toBe(true)
    expect(document.activeElement).toBe(opened)
  })
})

describe('completeQuickOpenEditorHandoff', () => {
  it('keeps a dismissed dialog from restoring focus, and focuses the editor after a file open', () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const editor = mountEditor('opened-file', 'wt')
    const event = new Event('focusout', { cancelable: true })

    completeQuickOpenEditorHandoff(event, { fileId: 'opened-file', worktreeId: 'wt' })

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(editor)
    frames.shift()?.(0)
    frames.shift()?.(0)
    expect(document.activeElement).toBe(editor)
  })

  it('does not move focus when the dialog was dismissed without opening a file', () => {
    const previous = document.createElement('button')
    document.body.append(previous)
    previous.focus()
    const event = new Event('focusout', { cancelable: true })

    completeQuickOpenEditorHandoff(event, null)

    expect(event.defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(previous)
  })
})
