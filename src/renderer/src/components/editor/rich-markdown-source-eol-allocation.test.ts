import { afterEach, describe, expect, it, vi } from 'vitest'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import {
  reconcileSerializedMarkdown,
  restoreMarkdownSourceEol
} from './rich-markdown-source-reconcile'

describe('rich Markdown source line-ending allocation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serializes a supported LF edit without collecting a match for every newline', () => {
    const source = `\`\`\`js\n${'x\n'.repeat(300_000)}const value=1;\n\`\`\`\n`
    const canonical = source.slice(0, -1)
    const edited = canonical.replace('value=1', 'value=2')
    const roundTrip = vi.fn(() => null)
    const originalMatch = RegExp.prototype[Symbol.match]
    let largestGlobalMatchArray = 0
    vi.spyOn(RegExp.prototype, Symbol.match).mockImplementation(function (
      this: RegExp,
      value: string
    ) {
      const result = originalMatch.call(this, value)
      if (this.global && result) {
        largestGlobalMatchArray = Math.max(largestGlobalMatchArray, result.length)
      }
      return result
    })

    expect(source.length).toBeLessThanOrEqual(RICH_MARKDOWN_MAX_SIZE_BYTES)
    expect(
      reconcileSerializedMarkdown({
        originalSource: source,
        baseCanonical: canonical,
        edited,
        roundTrip
      })
    ).toBe(`${edited}\n`)
    expect(restoreMarkdownSourceEol(edited, source)).toBe(edited)
    expect(roundTrip).not.toHaveBeenCalled()
    expect(largestGlobalMatchArray).toBe(0)
  })

  it.each([
    ['empty source', '', '\n'],
    ['no line ending', 'text', '\n'],
    ['LF only', 'a\nb\n', '\n'],
    ['CRLF only', 'a\r\nb\r\n', '\r\n'],
    ['lone CR only', 'a\rb\r', '\n'],
    ['lone CR before CRLF', 'a\r\r\nb', '\r\n'],
    ['CRLF first in a tie', 'a\r\nb\n', '\r\n'],
    ['LF first in a tie', 'a\nb\r\n', '\r\n'],
    ['LF majority', 'a\nb\r\nc\n', '\n'],
    ['CRLF majority', 'a\r\nb\nc\r\n', '\r\n'],
    ['Unicode separators', '\u2028\u2029', '\n'],
    ['lone surrogates and NUL', '\ud800\n\udfff\0', '\n']
  ])('preserves the existing decision for %s', (_name, source, eol) => {
    const content = 'new\r\nline\n\ud800\udfff\0'
    expect(restoreMarkdownSourceEol(content, source)).toBe(`new${eol}line${eol}\ud800\udfff\0`)
  })
})
