import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import { MarkdownManager } from '@tiptap/markdown'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import {
  getMarkdownRichModeEligibility,
  getMarkdownRichModeUnsupportedReason
} from './markdown-rich-mode'
import * as roundTrip from './markdown-round-trip'
import * as rawHtml from './raw-markdown-html'
import { createRichMarkdownExtensions } from './rich-markdown-extensions'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'

const largePrefix = 'A paragraph of ordinary Markdown.\n\n'.repeat(1600)
const comments = [
  '<!---->',
  '<!-- inline note -->',
  '<!--\nmultiline `code` and <Widget />\n\nmetadata: café 🌍\n-->',
  '<!--\r\nkeep CRLF and  spaces\r\n-->',
  `<!-- ${'long metadata '.repeat(4000)} -->`,
  '<!-- first --><!-- second -->'
]

afterEach(() => vi.restoreAllMocks())

describe('rich editing of Markdown documents with HTML comments', () => {
  it.each(comments)('admits preserved comment case %# without a full editor probe', (comment) => {
    const probe = vi.spyOn(roundTrip, 'getRichMarkdownRoundTripOutput')
    const content = `${largePrefix}Before ${comment} after\n`
    expect(content.length).toBeGreaterThan(50_000)
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })

  it.each(['<!---->', 'Before <!----> after'])(
    'admits and preserves %j with real validators',
    (content) => {
      expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
      const saved = roundTrip.getRichMarkdownRoundTripOutput(content)
      expect(saved).toContain('<!---->')
      expect(roundTrip.getRichMarkdownRoundTripOutput(saved!)).toBe(saved)
    }
  )

  it.each(['', largePrefix])(
    'preserves backticks in adjacent metadata comments at size %#',
    (prefix) => {
      const comment = '<!-- Read the YAML `refs` header. -->'
      const content = `---\nrefs: [spec]\n---\n${prefix}<!-- Related: spec -->\n${comment}\n\n# Architecture\n\nUse \`core-<name>\`.\n`
      expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
      expect(roundTrip.getRichMarkdownRoundTripOutput(content)).toContain(comment)
    }
  )

  it('limits parsing to comment-containing blocks in a large document', () => {
    const parse = vi.spyOn(MarkdownManager.prototype, 'parse')
    const content = `${largePrefix.repeat(12)}Before <!-- important --> after`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
    expect(parse).toHaveBeenCalled()
    expect(parse.mock.calls.every(([source]) => source.length < 50_000)).toBe(true)
  })

  it.each([
    ...comments.map((comment, index) => ({
      name: `inline comment ${index + 1}`,
      expected: `Before ${comment} edited`
    })),
    { name: 'standalone empty comment', expected: '<!---->\n\nBefore edited' },
    { name: 'standalone comment', expected: '<!-- standalone -->\n\nBefore edited' },
    { name: 'standalone multiline comment', expected: '<!--\nmetadata\n-->\n\nBefore edited' },
    { name: 'list comment', expected: '- Before <!-- list --> edited' },
    { name: 'quote comment', expected: '> Before <!-- quote --> edited' },
    { name: 'image alt comment', expected: '![<!-- alt text -->](image.png)\n\nBefore edited' },
    { name: 'duplicate comments', expected: 'Before <!-- same --><!-- same --> edited' }
  ])('preserves $name across an edit and reopen', ({ expected }) => {
    const content = `${largePrefix}${expected.replace(' edited', ' after')}\n`
    const codec = createRichMarkdownEditorCodec()
    const editor = new Editor({
      element: null,
      extensions: createRichMarkdownExtensions({ codec }),
      content: rawHtml.encodeRawMarkdownHtmlForRichEditor(content, codec),
      contentType: 'markdown'
    })
    try {
      editor.state.doc.check()
      let position = -1
      editor.state.doc.descendants((node, pos) => {
        if (node.isText && node.text?.includes(' after')) {
          position = pos + node.text.indexOf(' after')
        }
      })
      expect(position).toBeGreaterThan(-1)
      editor.view.dispatch(editor.state.tr.insertText(' edited', position, position + 6))
      editor.state.doc.check()
      const saved = editor.getMarkdown()
      expect(saved).toContain(expected)
      expect(getMarkdownRichModeUnsupportedReason(saved)).toBeNull()
      editor.commands.setContent(rawHtml.encodeRawMarkdownHtmlForRichEditor(saved, codec), {
        contentType: 'markdown'
      })
      editor.state.doc.check()
      expect(editor.getMarkdown()).toBe(saved)
    } finally {
      editor.destroy()
    }
  })

  it('allows standalone comments, front matter, and code examples', () => {
    const content = `---\ntitle: Notes\n---\n${largePrefix}\n<!-- block -->\n\n<!--\nmultiline\n-->\n\nUse \`<Widget />\` and \`<!-- example -->\`.\n\n\`\`\`html\n<div>example</div>\n<!-- example -->\n\`\`\`\n`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBeNull()
  })

  it('blocks comments when the encoder fails to preserve them', () => {
    const encode = rawHtml.encodeRawMarkdownHtmlForRichEditor
    vi.spyOn(rawHtml, 'encodeRawMarkdownHtmlForRichEditor').mockImplementation((content, codec) =>
      encode(content.replace('important', 'changed'), codec)
    )
    expect(getMarkdownRichModeUnsupportedReason(`${largePrefix}<!-- important -->`)).toBe(
      'html-or-jsx'
    )
  })

  it.each([
    '<!-- retained -->\n\n<!-- unfinished',
    '<!--\n  [ref]: https://example.com\n-->',
    '<!-- retained -->\n<!--->'
  ])('blocks comments that cannot be safely transported: %s', (tail) => {
    expect(getMarkdownRichModeUnsupportedReason(`${largePrefix}${tail}`)).toBe('html-or-jsx')
  })

  it.each(['[link](https://example.com "<!-- title -->")', '$<!-- math -->$'])(
    'blocks comment tokens that would become literal metadata: %s',
    (tail) => {
      expect(getMarkdownRichModeUnsupportedReason(`${largePrefix}${tail}`)).toBe('html-or-jsx')
    }
  )

  it.each(['<span>text</span>', '<Widget />', '<div>block</div>'])(
    'retains the large-document guard for comments mixed with %s',
    (html) => {
      expect(getMarkdownRichModeUnsupportedReason(`${largePrefix}<!-- note -->\n${html}`)).toBe(
        'html-or-jsx'
      )
    }
  )

  it.each([
    ['[ref]: https://example.com', 'reference-links'],
    ['[^note]: footnote', 'reference-links']
  ])('retains the unsupported-syntax guard for %s', (syntax, reason) => {
    expect(getMarkdownRichModeUnsupportedReason(`${largePrefix}<!-- note -->\n${syntax}`)).toBe(
      reason
    )
  })

  it('retains the separate rich editor size limit and its override', () => {
    const content = `${largePrefix.repeat(Math.ceil(RICH_MARKDOWN_MAX_SIZE_BYTES / largePrefix.length))}<!-- note -->`
    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: false })).toEqual({
      exceedsSizeLimit: true,
      unsupportedMessage: null
    })
    expect(getMarkdownRichModeEligibility({ content, sizeOverridden: true })).toEqual({
      exceedsSizeLimit: false,
      unsupportedMessage: null
    })
  })

  it('keeps pathological comment blocks behind the validation budget', () => {
    const content = `${'a'.repeat(50_001)} <!-- note -->`
    expect(getMarkdownRichModeUnsupportedReason(content)).toBe('html-or-jsx')
    expect(getMarkdownRichModeUnsupportedReason('<!-- note -->\n\n'.repeat(4000))).toBe(
      'html-or-jsx'
    )
  })
})
