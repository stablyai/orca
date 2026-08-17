// @vitest-environment happy-dom
import type { Editor } from '@tiptap/react'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { autoFocusRichEditor } from './rich-markdown-auto-focus'

function createEditor(
  focus = vi.fn(),
  domFocus: (options?: FocusOptions) => void = vi.fn(),
  selection: object = {}
): Editor {
  return {
    isDestroyed: false,
    commands: { focus },
    state: { selection },
    view: { dom: { focus: domFocus } }
  } as unknown as Editor
}

function setupScheduledFocus(
  activeElement: object | null,
  force = false,
  selection: object = {}
): {
  focus: ReturnType<typeof vi.fn>
  runFrame: () => void
} {
  let pendingFrame: FrameRequestCallback = () => {
    throw new Error('expected focus frame to be scheduled')
  }
  const focus = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    pendingFrame = callback
    return 7
  })
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.stubGlobal('document', { activeElement, body: {} })
  autoFocusRichEditor(createEditor(focus, vi.fn(), selection), null, force)

  return {
    focus,
    runFrame: () => pendingFrame(0)
  }
}

describe('autoFocusRichEditor', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    document.body.replaceChildren()
  })

  it('returns cleanup that cancels the pending focus frame', () => {
    const cancelAnimationFrameMock = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 42)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrameMock)

    const cleanup = autoFocusRichEditor(createEditor(), null)
    cleanup()
    cleanup()

    expect(cancelAnimationFrameMock).toHaveBeenCalledTimes(1)
    expect(cancelAnimationFrameMock).toHaveBeenCalledWith(42)
  })

  it('focuses the editor when the frame fires with neutral focus', () => {
    const { focus, runFrame } = setupScheduledFocus(null)
    runFrame()

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('preserves a restored text selection on an ordinary remount', () => {
    const selection = Object.create(TextSelection.prototype)
    const { focus, runFrame } = setupScheduledFocus(null, false, selection)
    runFrame()

    expect(focus).toHaveBeenCalledWith(null, { scrollIntoView: false })
  })

  it('restores the selection after an editor tab activation', () => {
    let runFrame: FrameRequestCallback = () => {}
    const tab = document.createElement('div')
    tab.dataset.tabId = 'editor-tab'
    tab.tabIndex = 0
    document.body.append(tab)
    tab.focus()
    const selection = Object.create(TextSelection.prototype)
    const focus = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      runFrame = callback
      return 8
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    autoFocusRichEditor(createEditor(focus, vi.fn(), selection), null)
    runFrame(0)

    expect(focus).toHaveBeenCalledWith(null, { scrollIntoView: false })
  })

  it('starts at the beginning for an explicit handoff', () => {
    const selection = Object.create(TextSelection.prototype)
    const { focus, runFrame } = setupScheduledFocus(null, true, selection)
    runFrame()

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })
  it('honors an explicit focus handoff', () => {
    const { focus, runFrame } = setupScheduledFocus({}, true)
    runFrame()

    expect(focus).toHaveBeenCalledWith('start', { scrollIntoView: false })
  })

  it('claims DOM focus synchronously on an explicit handoff', () => {
    const root = document.createElement('div')
    const editorDom = document.createElement('div')
    editorDom.tabIndex = -1
    root.append(editorDom)
    document.body.append(root)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 11)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    autoFocusRichEditor(createEditor(vi.fn(), editorDom.focus.bind(editorDom)), root, true)

    expect(root.contains(document.activeElement)).toBe(true)
  })

  it('leaves DOM focus alone for an ordinary lazy mount', () => {
    const domFocus = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 12)
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    autoFocusRichEditor(createEditor(vi.fn(), domFocus), null, false)

    expect(domFocus).not.toHaveBeenCalled()
  })

  it('does not run deferred focus after an explicit handoff expires', () => {
    let runFrame: FrameRequestCallback = () => {}
    let requestActive = true
    const focus = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      runFrame = callback
      return 13
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    autoFocusRichEditor(createEditor(focus), null, true, () => requestActive)
    requestActive = false
    runFrame(0)

    expect(focus).not.toHaveBeenCalled()
  })

  it('does not steal focus from other controls outside the editor', () => {
    const { focus, runFrame } = setupScheduledFocus({})
    runFrame()

    expect(focus).not.toHaveBeenCalled()
  })
})
