// @vitest-environment happy-dom
import { Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AllSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

const editors: Editor[] = []
function createEditor() {
  const editor = new Editor({ extensions: [StarterKit], content: '<p>selected text</p>' })
  editors.push(editor)
  const focus = vi.fn()
  vi.spyOn(editor, 'commands', 'get').mockReturnValue({ ...editor.commands, focus })
  return { editor, focus }
}

function schedule(editor: Editor, root: HTMLElement | null = null, force = false) {
  let runFrame: FrameRequestCallback = () => {
    throw new Error('Expected a focus frame')
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    runFrame = callback
    return 7
  })
  const cancelFrame = vi.fn()
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
  const cleanup = autoFocusRichEditor(editor, root, force)
  return { runFrame: () => runFrame(0), cancelFrame, cleanup }
}

function paneTab(groupId = 'group-a', worktreeId = 'folder:a', selected = true) {
  const strip = document.createElement('div')
  strip.dataset.tabGroupStripId = groupId
  strip.dataset.worktreeId = worktreeId
  const tab = document.createElement('div')
  tab.tabIndex = 0
  tab.dataset.tabId = 'tab-a'
  tab.dataset.active = String(selected)
  strip.append(tab)
  document.body.append(strip)
  tab.focus()
  return tab
}

function editorRoot(groupId = 'group-a', worktreeId = 'folder:a') {
  const body = document.createElement('div')
  body.dataset.tabGroupBodyId = groupId
  body.dataset.worktreeId = worktreeId
  const root = document.createElement('div')
  body.append(root)
  document.body.append(body)
  return root
}

afterEach(() => {
  vi.unstubAllGlobals()
  editors.splice(0).forEach((editor) => editor.destroy())
  document.body.replaceChildren()
})

describe('autoFocusRichEditor', () => {
  it('cancels pending focus on cleanup', () => {
    const { editor } = createEditor()
    const { cleanup, cancelFrame } = schedule(editor)
    cleanup()
    cleanup()
    expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('preserves a text selection with neutral DOM focus', () => {
    const { editor, focus } = createEditor()
    editor.commands.setTextSelection({ from: 4, to: 8 })
    schedule(editor).runFrame()
    expect(focus).toHaveBeenCalledWith(null, { scrollIntoView: false })
  })

  it('gives an initial AllSelection a normal caret', () => {
    const { editor, focus } = createEditor()
    editor.view.dispatch(editor.state.tr.setSelection(new AllSelection(editor.state.doc)))
    schedule(editor).runFrame()
    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('retains the explicit Explorer handoff', () => {
    const { editor, focus } = createEditor()
    const root = editorRoot()
    root.append(editor.view.dom)
    schedule(editor, root, true).runFrame()
    expect(root.contains(document.activeElement)).toBe(true)
    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('does not claim DOM focus before an ordinary mount frame', () => {
    const { editor } = createEditor()
    const domFocus = vi.spyOn(editor.view.dom, 'focus')
    schedule(editor)
    expect(domFocus).not.toHaveBeenCalled()
  })

  it('honors the deferred handoff fence and destroyed editor', () => {
    const { editor, focus } = createEditor()
    let active = true
    let frame: FrameRequestCallback = () => {}
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frame = callback
      return 9
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    autoFocusRichEditor(editor, null, true, () => active)
    active = false
    frame(0)
    expect(focus).not.toHaveBeenCalled()
    active = true
    editor.destroy()
    frame(0)
    expect(focus).not.toHaveBeenCalled()
  })

  it('hands the selected tab in the same pane back to its editor', () => {
    const { editor, focus } = createEditor()
    const root = editorRoot()
    paneTab()
    schedule(editor, root).runFrame()
    expect(focus).toHaveBeenCalledWith(null, { scrollIntoView: false })
  })

  it.each([
    ['other pane', 'group-b', 'folder:a', true],
    ['other workspace', 'group-a', 'folder:b', true],
    ['inactive tab', 'group-a', 'folder:a', false]
  ])('leaves focus on an %s', (_name, groupId, worktreeId, selected) => {
    const { editor, focus } = createEditor()
    const root = editorRoot()
    paneTab(String(groupId), String(worktreeId), selected === true)
    schedule(editor, root).runFrame()
    expect(focus).not.toHaveBeenCalled()
  })

  it('leaves unrelated inputs and tab close buttons alone', () => {
    const { editor, focus } = createEditor()
    const root = editorRoot()
    const input = document.createElement('input')
    document.body.append(input)
    input.focus()
    schedule(editor, root).runFrame()
    expect(focus).not.toHaveBeenCalled()
    const tab = paneTab()
    const close = document.createElement('button')
    tab.append(close)
    close.focus()
    schedule(editor, root).runFrame()
    expect(focus).not.toHaveBeenCalled()
  })

  it('does not claim tab focus for a detached editor root', () => {
    const { editor, focus } = createEditor()
    const root = editorRoot()
    root.remove()
    paneTab()
    schedule(editor, root).runFrame()
    expect(focus).not.toHaveBeenCalled()
  })
})
