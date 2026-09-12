import { describe, expect, it } from 'vitest'
import { decodeLeakedRichMarkdownTransport } from './MermaidBlock'

describe('decodeLeakedRichMarkdownTransport', () => {
  it('decodes leaked ORCA rich markdown tokens', () => {
    const input =
      'A[[ORCA_RICH_MD:a7bc3000000000000000000000000000:inline-html:%3Cbr%2F%3E]]B[[ORCA_RICH_MD:08ebb000000000000000000000000000:inline-html:%3Cbr%3E]]C'

    expect(decodeLeakedRichMarkdownTransport(input)).toBe('A<br/>B<br>C')
  })

  it('keeps malformed tokens unchanged', () => {
    const input =
      '[[ORCA_RICH_MD:a7bc3000000000000000000000000000:inline-html:%E0%A4%A]] and plain text'

    expect(decodeLeakedRichMarkdownTransport(input)).toBe(input)
  })

  it('does not modify regular mermaid text', () => {
    const input = 'graph TD\nA[Line 1<br/>Line 2] --> B'

    expect(decodeLeakedRichMarkdownTransport(input)).toBe(input)
  })
})
