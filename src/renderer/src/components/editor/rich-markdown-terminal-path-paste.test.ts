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
