import { describe, expect, it } from 'vitest'
import {
  getRichMarkdownFenceRanges,
  hasMarkdownContainerFenceCandidate
} from './markdown-container-code-ranges'
import { normalizeMarkdownReferenceLinks } from './markdown-reference-link-normalization'
import { encodeRawMarkdownHtmlForRichEditor } from './raw-markdown-html'
import { createRichMarkdownEditorCodec } from './rich-markdown-source-transport'
import { getMarkdownRichModeUnsupportedReason } from './markdown-rich-mode'

const marked = createRichMarkdownEditorCodec().marked

const internal = '[inside]: https://example.com/inside'
const outside = '[outside]: https://example.com/outside'

const containers = [
  { name: 'quote', open: '> ', continuation: '> ' },
  { name: 'nested quote', open: '>> ', continuation: '>> ' },
  { name: 'list', open: '- ', continuation: '  ' },
  { name: 'ordered list', open: '1. ', continuation: '   ' },
  { name: 'quote in list', open: '- > ', continuation: '  > ' },
  { name: 'list in quote', open: '> - ', continuation: '>   ' },
  { name: 'tabbed list', open: '- ', continuation: '\t' }
]

describe('container code source boundaries', () => {
  it.each(containers)(
    'protects $name code but normalizes outside references',
    ({ open, continuation }) => {
      const source = `${open}~~~text\n${continuation}${internal}\n${continuation}<br/>\n${continuation}~~~\n\n[Outside]\n${outside}\n`
      const normalized = normalizeMarkdownReferenceLinks(source)
      expect(normalized).toContain(internal)
      expect(normalized).toContain('[Outside](https://example.com/outside)')
      expect(normalized).not.toContain(outside)
      const codec = createRichMarkdownEditorCodec()
      const encoded = encodeRawMarkdownHtmlForRichEditor(source, codec)
      expect(encoded).toContain(`${continuation}<br/>`)
      expect(encoded).not.toContain(codec.transport.authoredPrefix)
    }
  )

  it.each(['\n', '\r\n', '\r'])('keeps original %j offsets and bytes', (eol) => {
    const source = ['> ~~~text', `> ${internal}`, '> ~~~', '', '[Outside]', outside].join(eol)
    const normalized = normalizeMarkdownReferenceLinks(source)
    expect(normalized).toContain(`> ${internal}${eol}`)
    expect(normalized).toContain(`[Outside](https://example.com/outside)`)
  })

  it.each(['> ', '>> ', '- ', '1. '])('ends unclosed %j code at its container boundary', (open) => {
    const continuation = open.includes('>') ? open : ' '.repeat(open.length)
    const source = `${open}~~~text\n${continuation}${internal}\n\n[Outside]\n${outside}`
    const normalized = normalizeMarkdownReferenceLinks(source)
    expect(normalized).toContain(internal)
    expect(normalized).toContain('[Outside](https://example.com/outside)')
  })

  it.each(['```~~~', '~~~```'])('matches Marked mixed-marker closer %j', (closer) => {
    const fence = closer.startsWith('`') ? '```' : '~~~'
    const source = `> ${fence}text\n> ${internal}\n> ${closer}\n> <br/> outside\n\n[Outside]\n${outside}`
    const codec = createRichMarkdownEditorCodec()
    const encoded = encodeRawMarkdownHtmlForRichEditor(source, codec)
    expect(encoded).toContain(`> ${internal}`)
    expect(encoded).not.toContain('> <br/> outside')
    expect(normalizeMarkdownReferenceLinks(source)).toContain(
      '[Outside](https://example.com/outside)'
    )
  })

  it.each(['~~~ invalid', '~~~\t', '    ~~~', '~~'])(
    'rejects the invalid quoted closer %j',
    (closer) => {
      const source = `> ~~~text\n> ${internal}\n> ${closer}\n> <br/> inside\n> ~~~\n\n[Outside]\n${outside}`
      const codec = createRichMarkdownEditorCodec()
      const encoded = encodeRawMarkdownHtmlForRichEditor(source, codec)
      expect(encoded).toContain('> <br/> inside')
      expect(encoded).not.toContain(codec.transport.authoredPrefix)
      expect(normalizeMarkdownReferenceLinks(source)).toContain(
        '[Outside](https://example.com/outside)'
      )
    }
  )

  it('does not treat a four-space top-level line as a fence', () => {
    const source = `    ~~~text\n${outside}\n[Outside]`
    expect(normalizeMarkdownReferenceLinks(source)).toContain(
      '[Outside](https://example.com/outside)'
    )
  })

  it('maps code after duplicate definitions that Marked consumes without emitting tokens', () => {
    const source = `${outside}\n${outside}\n\n> ~~~text\n> ${internal}\n> ~~~\n\n[Outside]`
    expect(normalizeMarkdownReferenceLinks(source)).toContain(`> ${internal}`)
    expect(normalizeMarkdownReferenceLinks(source)).toContain(
      '[Outside](https://example.com/outside)'
    )
  })

  it('agrees with public Marked code boundaries across container layouts', () => {
    const mismatches: string[] = []
    const headers = [
      '',
      `${outside}\n\n`,
      `${outside}\n${outside}\n\n`,
      'Prose\n\n',
      '-\n\n',
      '> Quote\n>\n',
      '> Quote\n===\n',
      '> Quote\n---\n'
    ]
    for (const header of headers) {
      for (const { open, continuation } of containers) {
        for (const fence of ['```', '~~~']) {
          for (const suffix of ['', ' invalid', '\t', '~~~', '```']) {
            const source = `${header}${open}${fence}text\n${continuation}SENTINEL<br/>\n${continuation}${fence}${suffix}\n${continuation}AFTER<br/>\n\nOUTSIDE<br/>`
            const codeText: string[] = []
            marked.walkTokens(marked.lexer(source), (token) => {
              if (token.type === 'code' && token.codeBlockStyle !== 'indented') {
                codeText.push(token.text)
              }
            })
            const ranges = getRichMarkdownFenceRanges(source)
            if (!ranges) {
              mismatches.push(`unmapped: ${source}`)
              continue
            }
            for (const sentinel of ['SENTINEL<br/>', 'AFTER<br/>', 'OUTSIDE<br/>']) {
              const index = source.indexOf(sentinel)
              const protectedSource = ranges.some(([start, end]) => index >= start && index < end)
              if (protectedSource !== codeText.some((text) => text.includes(sentinel))) {
                mismatches.push(`${sentinel}: ${source}`)
              }
            }
          }
        }
      }
    }
    expect(mismatches).toEqual([])
  })

  it('keeps large container documents in Source without parsing a truncated body', () => {
    const source = `> ~~~text\n> ${'a'.repeat(50_000)}\n> ~~~`
    expect(getRichMarkdownFenceRanges(source)).toBeNull()
    expect(getMarkdownRichModeUnsupportedReason(source)).toBe('other')
    expect(encodeRawMarkdownHtmlForRichEditor(source, createRichMarkdownEditorCodec())).toBe(source)
  })

  it.each([1, 2, 3])('keeps a large top-level fence indented %i spaces eligible', (spaces) => {
    const indent = ' '.repeat(spaces)
    const source = `${indent}~~~text\n${'a'.repeat(50_000)}\n${indent}~~~`
    expect(hasMarkdownContainerFenceCandidate(source)).toBe(false)
    expect(getRichMarkdownFenceRanges(source)).not.toBeNull()
    expect(getMarkdownRichModeUnsupportedReason(source)).toBeNull()
  })

  it.each([
    `${' '.repeat(50_000)}literal`,
    `${'> '.repeat(5_000)}${' '.repeat(50_000)}literal`,
    `${'- '.repeat(5_000)}${' '.repeat(50_000)}literal`
  ])('rejects a long nonmatching prefix without a fence', (source) => {
    expect(hasMarkdownContainerFenceCandidate(source)).toBe(false)
  })
})
