import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownManager } from '@tiptap/markdown'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

afterEach(() => vi.restoreAllMocks())

const prefix = 'An ordinary paragraph.\n\n'.repeat(2500)

describe('rich editing of large Markdown with HTML line breaks', () => {
  it.each(['<br>', '<br/>', '<br />', '<BR />'])(
    'admits preserved %s in a table alongside comments',
    (lineBreak) => {
      const content = `${prefix}<!-- note -->\n\n| Field | Value |\n| --- | --- |\n| Options | before ${lineBreak} \`a\` \\| \`b\`, tail |\n`
      expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
    }
  )

  it('admits line breaks without requiring a comment', () => {
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}Before<br>after`)).toBeNull()
  })

  it('rejects a probe that retains HTML but loses surrounding text on reopen', () => {
    vi.spyOn(MarkdownManager.prototype, 'serialize').mockReturnValue('Before<br>changed')
    expect(getMarkdownRichModeUnsupportedReason(`${prefix}Before<br>keep this`)).toBe('html-or-jsx')
  })

  it.each(['<br class="gap">', '<br onclick="alert(1)">', '</br>', '<div>text</div>'])(
    'retains the existing guard for %s',
    (html) => {
      expect(getMarkdownRichModeUnsupportedReason(`${prefix}<!-- note -->\n${html}`)).toBe(
        'html-or-jsx'
      )
    }
  )
})
