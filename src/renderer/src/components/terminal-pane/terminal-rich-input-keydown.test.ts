// @vitest-environment happy-dom
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  handleTerminalRichInputKeyDown,
  insertTerminalRichInputHardBreak
} from './terminal-rich-input-keydown'

function context() {
  return {
    mentionRef: { current: null },
    slashRef: { current: { from: 1, to: 4, query: 'cl' } },
    fileSuggestionsRef: { current: [] as string[] },
    slashSuggestionsRef: {
      current: [{ name: 'clear', description: 'Clear conversation' }]
    },
    activeSuggestionRef: { current: 0 },
    setActiveSuggestion: vi.fn(),
    pasteImageFromClipboard: vi.fn(),
    insertHardBreak: vi.fn(() => true),
    chooseFile: vi.fn(),
    chooseSlash: vi.fn(),
    closeAutocomplete: vi.fn(),
    closeComposer: vi.fn(),
    submit: vi.fn()
  }
}

describe('terminal rich input keydown', () => {
  afterEach(() => vi.restoreAllMocks())

  it('inserts repeated trailing hard breaks and keeps the caret visible', () => {
    const editor = new Editor({ extensions: [StarterKit], content: '<p>line</p>' })
    Object.defineProperty(editor.view.dom, 'scrollHeight', { configurable: true, value: 240 })
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    expect(insertTerminalRichInputHardBreak(editor)).toBe(true)
    expect(insertTerminalRichInputHardBreak(editor)).toBe(true)
    expect(
      editor.getJSON().content?.[0]?.content?.filter((node) => node.type === 'hardBreak')
    ).toHaveLength(2)
    expect(editor.view.dom.scrollTop).toBe(240)
    editor.destroy()
  })

  it('uses ProseMirror scrolling for a hard break in the middle of the document', () => {
    const editor = new Editor({ extensions: [StarterKit], content: '<p>before after</p>' })
    editor.view.dom.scrollTop = 40
    editor.commands.setTextSelection(4)
    let scrolledIntoView = false
    editor.registerPlugin(
      new Plugin({
        filterTransaction: (transaction) => {
          scrolledIntoView ||= transaction.scrolledIntoView
          return true
        }
      })
    )

    expect(insertTerminalRichInputHardBreak(editor)).toBe(true)
    expect(scrolledIntoView).toBe(true)
    expect(editor.view.dom.scrollTop).toBe(40)
    expect(editor.getJSON().content?.[0]?.content?.some((node) => node.type === 'hardBreak')).toBe(
      true
    )
    editor.destroy()
  })

  it('probes for native clipboard images without consuming Cmd+V on macOS', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    const ctx = context()
    const event = new KeyboardEvent('keydown', { key: 'v', metaKey: true })

    expect(handleTerminalRichInputKeyDown(event, ctx)).toBe(false)
    expect(ctx.pasteImageFromClipboard).toHaveBeenCalledOnce()
    expect(event.defaultPrevented).toBe(false)
  })

  it('uses Ctrl+V and ignores Windows+V on non-Mac platforms', () => {
    vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const ctx = context()

    handleTerminalRichInputKeyDown(new KeyboardEvent('keydown', { key: 'v', metaKey: true }), ctx)
    expect(ctx.pasteImageFromClipboard).not.toHaveBeenCalled()

    handleTerminalRichInputKeyDown(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }), ctx)
    expect(ctx.pasteImageFromClipboard).toHaveBeenCalledOnce()
  })

  it('skips native image probes for repeated and plain-text paste chords', () => {
    const platform = vi.spyOn(window.navigator, 'userAgent', 'get').mockReturnValue('Windows')
    const ctx = context()

    handleTerminalRichInputKeyDown(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, repeat: true }),
      ctx
    )
    handleTerminalRichInputKeyDown(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, shiftKey: true }),
      ctx
    )
    platform.mockReturnValue('Macintosh')
    handleTerminalRichInputKeyDown(
      new KeyboardEvent('keydown', { key: 'v', metaKey: true, repeat: true }),
      ctx
    )
    handleTerminalRichInputKeyDown(
      new KeyboardEvent('keydown', { key: 'v', metaKey: true, shiftKey: true }),
      ctx
    )

    expect(ctx.pasteImageFromClipboard).not.toHaveBeenCalled()
  })

  it('ignores IME-owned Enter events', () => {
    const ctx = context()
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })
    Object.defineProperty(event, 'keyCode', { value: 229 })

    expect(handleTerminalRichInputKeyDown(event, ctx)).toBe(false)
    expect(ctx.chooseSlash).not.toHaveBeenCalled()
    expect(ctx.submit).not.toHaveBeenCalled()
  })

  it('closes the composer when a slash query has no visible suggestions', () => {
    const ctx = context()
    ctx.slashSuggestionsRef.current = []
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    expect(handleTerminalRichInputKeyDown(event, ctx)).toBe(true)
    expect(ctx.closeAutocomplete).not.toHaveBeenCalled()
    expect(ctx.closeComposer).toHaveBeenCalledOnce()
  })

  it('inserts a visible hard break on Shift+Enter', () => {
    const ctx = context()
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      shiftKey: true,
      cancelable: true
    })

    expect(handleTerminalRichInputKeyDown(event, ctx)).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(ctx.insertHardBreak).toHaveBeenCalledOnce()
    expect(ctx.submit).not.toHaveBeenCalled()
  })

  it('dispatches the selected slash command on Enter', () => {
    const ctx = context()
    const event = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true })

    expect(handleTerminalRichInputKeyDown(event, ctx)).toBe(true)
    expect(ctx.chooseSlash).toHaveBeenCalledWith(ctx.slashSuggestionsRef.current[0], true)
  })
})
