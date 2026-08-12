import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/react'
import {
  commitRichMarkdownSerialization,
  type RichMarkdownReconcileRefs
} from './rich-markdown-serialization-commit'
import { handleRichMarkdownSaveShortcut } from './rich-markdown-save-shortcut'
import type { KeyHandlerContext } from './rich-markdown-key-handler'

// Style-only canonicalizer mirroring the #6080 rewrites; stands in for the live
// editor's getMarkdown so these tests need no DOM. Strips the trailing newline
// like the real getMarkdown, so the branch-6 exact re-parse comparison behaves as
// in production (the reconcile roundTrip and the edited getMarkdown agree on EOF).
function fakeCanonicalize(md: string): string {
  return md
    .replace(/__([^_]+)__/g, '**$1**')
    .replace(/_([^_]+)_/g, '*$1*')
    .replace(/\n+$/, '')
}
const roundTrip = (md: string): string => fakeCanonicalize(md)

function refs(originalSource: string, baseCanonical: string): RichMarkdownReconcileRefs {
  return {
    originalSourceRef: { current: originalSource },
    baseCanonicalRef: { current: baseCanonical },
    lastCommittedMarkdownRef: { current: '' }
  }
}

function fakeEditor(getMarkdown: () => string): Editor {
  return { getMarkdown } as unknown as Editor
}

describe('commitRichMarkdownSerialization (shared disk-bound serialize chokepoint)', () => {
  it('persists SOURCE-PRESERVING bytes, not raw getMarkdown (regression gate for #6080)', () => {
    const r = refs('# Title\n\n_word_\n', '# Title\n\n*word*')
    const editor = fakeEditor(() => '# Title!\n\n*word*') // canonical edit

    const { markdown, didSerialize } = commitRichMarkdownSerialization(editor, r, roundTrip)

    // Fails if this site reverted to raw getMarkdown() (would emit *word*).
    expect(markdown).toBe('# Title!\n\n_word_\n')
    expect(didSerialize).toBe(true)
  })

  it('advances all three refs so the next incremental edit patches onto the reconciled source', () => {
    const r = refs('# Title\n\n_word_\n', '# Title\n\n*word*')
    const editor = fakeEditor(() => '# Title!\n\n*word*')

    commitRichMarkdownSerialization(editor, r, roundTrip)

    expect(r.originalSourceRef.current).toBe('# Title!\n\n_word_\n') // reconciled bytes
    expect(r.baseCanonicalRef.current).toBe('# Title!\n\n*word*') // canonical of reconciled
    expect(r.lastCommittedMarkdownRef.current).toBe('# Title!\n\n_word_\n') // exact disk bytes
  })

  it('falls back to the last committed bytes when the editor is torn down (null)', () => {
    const r = refs('# Title\n\n_word_\n', '# Title\n\n*word*')
    r.lastCommittedMarkdownRef.current = '# Title\n\n_word_\n'

    const { markdown, didSerialize } = commitRichMarkdownSerialization(null, r, roundTrip)

    expect(didSerialize).toBe(false)
    expect(markdown).toBe('# Title\n\n_word_\n')
    // Refs untouched on a torn-down editor.
    expect(r.originalSourceRef.current).toBe('# Title\n\n_word_\n')
  })

  it('does not crash when getMarkdown throws (editor destroyed mid-flush)', () => {
    const r = refs('src', 'src')
    r.lastCommittedMarkdownRef.current = 'safe'
    const editor = fakeEditor(() => {
      throw new Error('editor destroyed')
    })

    const { markdown, didSerialize } = commitRichMarkdownSerialization(editor, r, roundTrip)

    expect(didSerialize).toBe(false)
    expect(markdown).toBe('safe')
  })

  it('preserves source EOL and advances refs when reconciliation throws', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = refs('# 이전\r\n\r\n_강조_\r\n', '# 이전\n\n*강조*')
    const editor = fakeEditor(() => '# 변경\n\n*강조*')
    const throwingRoundTrip = vi.fn(() => {
      throw new Error('round-trip failed')
    })

    try {
      const { markdown, didSerialize } = commitRichMarkdownSerialization(
        editor,
        r,
        throwingRoundTrip
      )

      expect(markdown).toBe('# 변경\r\n\r\n*강조*')
      expect(didSerialize).toBe(true)
      expect(r.originalSourceRef.current).toBe(markdown)
      expect(r.baseCanonicalRef.current).toBe('# 변경\n\n*강조*')
      expect(r.lastCommittedMarkdownRef.current).toBe(markdown)
      expect(throwingRoundTrip).toHaveBeenCalledTimes(1)
      expect(consoleError).toHaveBeenCalledTimes(1)
    } finally {
      consoleError.mockRestore()
    }
  })
})

describe('handleRichMarkdownSaveShortcut (Cmd/Ctrl+S persistence site)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function saveEvent(): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
    return {
      key: 's',
      code: 'KeyS',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      isComposing: false,
      preventDefault: vi.fn()
    } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
  }

  function saveContext(editor: Editor | null): {
    ctx: KeyHandlerContext
    onSave: ReturnType<typeof vi.fn>
    onContentChange: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
  } {
    const onSave = vi.fn()
    const onContentChange = vi.fn()
    const flush = vi.fn()
    const ctx = {
      editorRef: { current: editor },
      originalSourceRef: { current: '# Title\n\n_word_\n' },
      baseCanonicalRef: { current: '# Title\n\n*word*' },
      lastCommittedMarkdownRef: { current: '' },
      reconcileRoundTripRef: { current: roundTrip },
      onContentChangeRef: { current: onContentChange },
      onSaveRef: { current: onSave },
      flushPendingSerialization: flush
    } as unknown as KeyHandlerContext
    return { ctx, onSave, onContentChange, flush }
  }

  it('flushes then saves SOURCE-PRESERVING bytes on Cmd+S (mac)', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const editor = fakeEditor(() => '# Title!\n\n*word*')
    const { ctx, onSave, onContentChange, flush } = saveContext(editor)
    const event = saveEvent()

    expect(handleRichMarkdownSaveShortcut(ctx, event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(flush).toHaveBeenCalledTimes(1)
    // onSave/onContentChange receive reconciled bytes, not raw *word*.
    expect(onSave).toHaveBeenCalledWith('# Title!\n\n_word_\n')
    expect(onContentChange).toHaveBeenCalledWith('# Title!\n\n_word_\n')
  })

  it('ignores non-save keystrokes and touches nothing', () => {
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' })
    const editor = fakeEditor(() => '# Title!\n\n*word*')
    const { ctx, onSave, flush } = saveContext(editor)
    const event = { ...saveEvent(), key: 'a', code: 'KeyA' } as KeyboardEvent & {
      preventDefault: ReturnType<typeof vi.fn>
    }

    expect(handleRichMarkdownSaveShortcut(ctx, event)).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    expect(onSave).not.toHaveBeenCalled()
  })
})
