import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import type { EditorView } from '@tiptap/pm/view'
import { handleRichMarkdownEditorClick } from './rich-markdown-editor-click-routing'
import type { HttpLinkSourceOwner } from '@/lib/http-link-routing'

const openHttpLinkMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: openHttpLinkMock
}))

beforeEach(() => {
  openHttpLinkMock.mockReset()
})

// Why: the preview deliberately routes differently; this pins the editor side so a
// future "make them consistent" change cannot land silently.
function clickExternalLinkWithShift(sourceOwner: HttpLinkSourceOwner, isMac = true): boolean {
  const href = 'https://example.com/docs'
  const view = {
    state: {
      doc: {
        nodeAt: () => null,
        resolve: () => ({
          marks: () => [{ type: { name: 'link' }, attrs: { href } }]
        })
      }
    }
  } as unknown as EditorView

  return handleRichMarkdownEditorClick({
    activateMarkdownLink: vi.fn(),
    editorRef: { current: {} } as unknown as MutableRefObject<unknown>,
    event: { metaKey: isMac, ctrlKey: !isMac, shiftKey: true } as MouseEvent,
    filePath: '/repo/docs/README.md',
    isMac,
    htmlSuperscriptLinkContext: {
      getSnapshot: () => ({ sourceOwner })
    },
    markdownCommentsRef: { current: [] },
    markdownSourceLineOffsetRef: { current: 0 },
    onOpenDocLinkRef: { current: undefined },
    pos: 1,
    rootRef: { current: null },
    scrollRichMarkdownReviewNoteCardIntoView: vi.fn(),
    settings: {} as never,
    view,
    worktreeId: 'wt-1',
    worktreeRoot: '/repo'
  } as never)
}

describe('rich markdown editor Shift+modifier click on external links', () => {
  // Why: intentionally NOT the preview's behavior — this path hands the link to the
  // client OS, so it must keep forcing the system browser even when inverting is on.
  it('forces the system browser rather than following the invert setting', () => {
    expect(clickExternalLinkWithShift({ kind: 'local' })).toBe(true)
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/docs', {
      forceSystemBrowser: true,
      sourceOwner: { kind: 'local' }
    })
  })

  // Why: AGENTS.md — Shift+Ctrl is the chord off macOS, and modKey reads a
  // different event field there.
  it('uses the Ctrl chord off macOS', () => {
    expect(clickExternalLinkWithShift({ kind: 'local' }, false)).toBe(true)
    expect(openHttpLinkMock).toHaveBeenCalledWith('https://example.com/docs', {
      forceSystemBrowser: true,
      sourceOwner: { kind: 'local' }
    })
  })

  it('forwards a non-local source owner untouched', () => {
    const sourceOwner = { kind: 'ssh', connectionId: 'conn-1' } as HttpLinkSourceOwner

    expect(clickExternalLinkWithShift(sourceOwner)).toBe(true)
    expect(openHttpLinkMock).toHaveBeenCalledWith(
      'https://example.com/docs',
      expect.objectContaining({ forceSystemBrowser: true, sourceOwner })
    )
  })
})
