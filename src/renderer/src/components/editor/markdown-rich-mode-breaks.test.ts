import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownManager } from '@tiptap/markdown'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'
import { getRichMarkdownHtmlValidationOutput } from './markdown-rich-html-validation'

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
    expect(getRichMarkdownHtmlValidationOutput(`${prefix}Before<br>keep this`)).toBeNull()
  })

  it.each(['<br class="gap">', '<br onclick="alert(1)">', '</br>', '<div>text</div>'])(
    'leaves %s to the full round trip',
    (html) => {
      expect(getRichMarkdownHtmlValidationOutput(`${prefix}<!-- note -->\n${html}`)).toBeNull()
    }
  )
})
