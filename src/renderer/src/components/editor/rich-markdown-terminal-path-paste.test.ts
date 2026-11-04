// @vitest-environment happy-dom

import type { Editor } from '@tiptap/react'
import { describe, expect, it } from 'vitest'
import {
  handleRichMarkdownTerminalPathPaste,
  shouldPasteTerminalWindowsPathAsPlainText
} from './rich-markdown-terminal-path-paste'

type InsertTransaction = { text: string }

function makePasteEvent(text: string, html = ''): ClipboardEvent {
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true
  }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/plain' ? text : type === 'text/html' ? html : '')
    }
  })
  return event
}

function makeEditor(): { editor: Editor; inserted: string[] } {
  const inserted: string[] = []
  const editor = {
    get state() {
      return {
        tr: {
          insertText: (text: string): InsertTransaction => ({ text })
        }
      }
    },
    view: {
      dispatch: (transaction: InsertTransaction): void => {
        inserted.push(transaction.text)
      }
    }
  } as unknown as Editor

  return { editor, inserted }
}

describe('rich markdown terminal path paste', () => {
  it('detects terminal-style HTML links that would lose a Windows path', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Read C:\\Users\\neil\\.claude\\CLAUDE.md before editing.',
        htmlText:
          '<span>Read C:\\Users\\neil\\.claude\\</span><a href="http://CLAUDE.md">CLAUDE.md</a>'
      })
    ).toBe(true)
  })

  it('preserves a drive path with a spaced folder and surrounding prose', () => {
    const { editor, inserted } = makeEditor()
    const text = 'Read C:\\Users\\My Project\\README.md before editing.'
    const event = makePasteEvent(
      text,
      '<span>Read C:\\Users\\My Project\\</span><a href="http://README.md">README.md</a> before editing.'
    )

    expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(inserted).toEqual([text])
  })

  it('preserves a UNC path with a spaced folder and surrounding prose', () => {
    const { editor, inserted } = makeEditor()
    const text = 'Review \\\\build-server\\Team Docs\\README.md with the release notes.'
    const event = makePasteEvent(
      text,
      '<span>Review \\\\build-server\\Team Docs\\</span><a href="http://README.md">README.md</a> with the release notes.'
    )

    expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(inserted).toEqual([text])
  })

  it('retains UNC share-root path basenames', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open \\\\server\\Share.md before editing.',
        htmlText:
          '<span>Open \\\\server\\</span><a href="http://Share.md">Share.md</a> before editing.'
      })
    ).toBe(true)
  })

  it('matches an unspaced path basename with regex metacharacters', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open C:\\Users\\$README.md before editing.',
        htmlText: '<a href="http://$README.md">$README.md</a>'
      })
    ).toBe(true)
  })

  it('does not match a path when the linked basename is only a filename prefix', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open C:\\Users\\README.md.backup before editing.',
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(false)
  })

  it('allows a sentence-ending period after the linked basename', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open C:\\Users\\README.md.',
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(true)
  })

  it('preserves a Unicode path basename linked through an IDN hostname', () => {
    const { editor, inserted } = makeEditor()
    const text = 'Open C:\\Users\\My Project\\résumé.md'
    const event = makePasteEvent(text, '<a href="http://résumé.md">résumé.md</a>')

    expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(inserted).toEqual([text])
  })

  it('does not treat valid filename punctuation as the end of a basename', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open C:\\Users\\README.md,backup before editing.',
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(false)
  })

  it('does not match a Windows path to an unrelated same-sentence link', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open C:\\Users\\NOTES.txt and review README.md before editing.',
        htmlText: '<a href="http://README.md">README.md</a>'
      })
    ).toBe(false)
  })

  it('does not claim ordinary links or non-Windows paths', () => {
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: 'Open CLAUDE.md at https://example.test/CLAUDE.md',
        htmlText: '<a href="https://example.test/CLAUDE.md">CLAUDE.md</a>'
      })
    ).toBe(false)
    expect(
      shouldPasteTerminalWindowsPathAsPlainText({
        plainText: '/Users/neil/.claude/CLAUDE.md',
        htmlText: '<a href="http://CLAUDE.md">CLAUDE.md</a>'
      })
    ).toBe(false)
  })

  it('inserts the plain clipboard text before TipTap can preserve broken link metadata', () => {
    const { editor, inserted } = makeEditor()
    const text = 'C:\\Users\\neil\\.claude\\CLAUDE.md'
    const event = makePasteEvent(text, '<a href="http://CLAUDE.md">CLAUDE.md</a>')

    expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(true)

    expect(event.defaultPrevented).toBe(true)
    expect(inserted).toEqual([text])
  })

  it('falls through when the HTML link does not target the path basename', () => {
    const { editor, inserted } = makeEditor()
    const event = makePasteEvent(
      'C:\\Users\\neil\\.claude\\CLAUDE.md',
      '<a href="https://docs.example.test/config">CLAUDE.md</a>'
    )

    expect(handleRichMarkdownTerminalPathPaste(editor, event)).toBe(false)

    expect(event.defaultPrevented).toBe(false)
    expect(inserted).toEqual([])
  })
})
