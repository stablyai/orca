import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusEditorTabSurface } from './focus-editor-tab-surface'
import { beginActiveSurfaceFocus } from './active-surface-focus-generation'

const MARKDOWN_EDITOR_SELECTOR =
  '.rich-markdown-editor-shell .rich-markdown-editor[contenteditable="true"]'
const RENAME_INPUT_SELECTOR = '[data-tab-rename-input="true"]'

type FakeElement = {
  focus: ReturnType<typeof vi.fn>
  getClientRects: () => { length: number }
  contains: (other: unknown) => boolean
  closest: (selector: string) => unknown
}

function laidOutElement(): FakeElement {
  const element: FakeElement = {
    focus: vi.fn(),
    getClientRects: () => ({ length: 1 }),
    contains: () => false,
    closest: () => null
  }
  return element
}

function hiddenElement(): FakeElement {
  return {
    focus: vi.fn(),
    getClientRects: () => ({ length: 0 }),
    contains: () => false,
    closest: () => null
  }
}

// A laid-out `.native-edit-context` living in the read-only original (left) pane
// of a Monaco diff editor: `closest('.editor.original')` resolves to a node.
function diffOriginalElement(): FakeElement {
  return {
    focus: vi.fn(),
    getClientRects: () => ({ length: 1 }),
    contains: () => false,
    closest: (selector: string) => (selector === '.editor.original' ? {} : null)
  }
}

function nodeList(elements: FakeElement[]): { length: number; item: (index: number) => unknown } {
  return { length: elements.length, item: (index: number) => elements[index] ?? null }
}

describe('focusEditorTabSurface', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function flushAnimationFrames(): void {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  }

  function stubDocument(
    bySelector: Record<string, FakeElement[]>,
    activeElement: FakeElement | null,
    renameInput: FakeElement | null = null
  ): ReturnType<typeof vi.fn> {
    const querySelectorAll = vi.fn((selector: string) => nodeList(bySelector[selector] ?? []))
    const querySelector = vi.fn((selector: string) =>
      selector === RENAME_INPUT_SELECTOR ? renameInput : null
    )
    vi.stubGlobal('document', {
      querySelectorAll,
      querySelector,
      get activeElement() {
        return activeElement
      }
    })
    return querySelectorAll
  }

  it('focuses the visible monaco editor textarea', () => {
    flushAnimationFrames()
    const textarea = laidOutElement()
    stubDocument({ '.monaco-editor .native-edit-context': [textarea] }, textarea)

    focusEditorTabSurface()

    expect(textarea.focus).toHaveBeenCalled()
  })

  it('skips a display:none editor from a background workspace', () => {
    flushAnimationFrames()
    const hidden = hiddenElement()
    const visible = laidOutElement()
    stubDocument({ '.monaco-editor .native-edit-context': [hidden, visible] }, visible)

    focusEditorTabSurface()

    expect(hidden.focus).not.toHaveBeenCalled()
    expect(visible.focus).toHaveBeenCalled()
  })

  it('skips the read-only original pane of a diff and focuses the modified pane', () => {
    flushAnimationFrames()
    // DOM order in a Monaco diff: original (read-only, left) precedes modified.
    const original = diffOriginalElement()
    const modified = laidOutElement()
    stubDocument({ '.monaco-editor .native-edit-context': [original, modified] }, modified)

    focusEditorTabSurface()

    expect(original.focus).not.toHaveBeenCalled()
    expect(modified.focus).toHaveBeenCalled()
  })

  it('falls back to the shell-scoped rich markdown editor when no monaco textarea exists', () => {
    flushAnimationFrames()
    const editor = laidOutElement()
    // Selector is scoped to `.rich-markdown-editor-shell` so a visible PR/Linear
    // comment composer (bare `.rich-markdown-editor`) can never win.
    stubDocument({ [MARKDOWN_EDITOR_SELECTOR]: [editor] }, editor)

    focusEditorTabSurface()

    expect(editor.focus).toHaveBeenCalled()
  })

  it('scopes focus to the given split group and skips a sibling group editor', () => {
    flushAnimationFrames()
    const inGroup = laidOutElement()
    const sibling = laidOutElement()
    stubDocument(
      {
        '[data-tab-group-body-id="group-7"] .monaco-editor .native-edit-context': [inGroup],
        '.monaco-editor .native-edit-context': [sibling]
      },
      inGroup
    )

    focusEditorTabSurface('group-7')

    expect(inGroup.focus).toHaveBeenCalled()
    expect(sibling.focus).not.toHaveBeenCalled()
  })

  it('does not focus anything while an inline tab rename input is open', () => {
    flushAnimationFrames()
    const editor = laidOutElement()
    const renameInput = laidOutElement()
    stubDocument({ '.monaco-editor .native-edit-context': [editor] }, editor, renameInput)

    focusEditorTabSurface()

    // Focusing the editor would blur-commit the open rename; the guard bails.
    expect(editor.focus).not.toHaveBeenCalled()
  })

  it('aborts a pending retry once a newer focus request supersedes it', () => {
    const textarea = laidOutElement()
    let mounted = false
    const querySelectorAll = vi.fn((selector: string) =>
      nodeList(selector === '.monaco-editor .native-edit-context' && mounted ? [textarea] : [])
    )
    vi.stubGlobal('document', {
      querySelectorAll,
      querySelector: vi.fn(() => null),
      get activeElement() {
        return mounted ? textarea : null
      }
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    focusEditorTabSurface()
    // First frame: editor still mounting, another frame queued.
    frames.shift()?.(0)
    expect(frames).toHaveLength(1)

    // A newer navigation (e.g. a terminal jump) supersedes this request, then the
    // editor finally mounts. The stale loop must NOT steal focus back.
    beginActiveSurfaceFocus()
    mounted = true
    frames.shift()?.(0)
    expect(textarea.focus).not.toHaveBeenCalled()
  })

  it('never queries or focuses a terminal surface', () => {
    flushAnimationFrames()
    const querySelectorAll = stubDocument({}, null)

    focusEditorTabSurface()

    // Why: the editor path must never fall through to '.xterm-helper-textarea',
    // otherwise an editor tab would steal focus onto a hidden terminal.
    for (const call of querySelectorAll.mock.calls) {
      expect(call[0]).not.toBe('.xterm-helper-textarea')
    }
  })

  it('retries on later frames while the lazy editor is still mounting', () => {
    const textarea = laidOutElement()
    let mounted = false
    const querySelectorAll = vi.fn((selector: string) =>
      nodeList(selector === '.monaco-editor .native-edit-context' && mounted ? [textarea] : [])
    )
    vi.stubGlobal('document', {
      querySelectorAll,
      querySelector: vi.fn(() => null),
      get activeElement() {
        return mounted ? textarea : null
      }
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    vi.stubGlobal('cancelAnimationFrame', vi.fn())

    focusEditorTabSurface()
    // First frame: editor not mounted yet — nothing focused, another frame queued.
    frames.shift()?.(0)
    expect(textarea.focus).not.toHaveBeenCalled()
    expect(frames).toHaveLength(1)

    // Editor mounts; next frame focuses it.
    mounted = true
    frames.shift()?.(0)
    expect(textarea.focus).toHaveBeenCalled()
  })

  it('cancels a pending focus frame when a newer focus request starts', () => {
    const cancelAnimationFrame = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 9)
    )
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame)
    vi.stubGlobal('document', {
      querySelectorAll: vi.fn((_selector: string) => nodeList([]))
    })

    focusEditorTabSurface()
    focusEditorTabSurface()

    expect(cancelAnimationFrame).toHaveBeenCalledWith(9)
  })
})
