import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { visit } from 'unist-util-visit'
import { describe, expect, it } from 'vitest'
import {
  createClosingFenceCheck,
  MARKDOWN_CLOSING_FENCE,
  remarkMarkdownClosingFence
} from './comment-markdown-code-fence'

const parser = unified().use(remarkParse).use(remarkMarkdownClosingFence)

function confirmed(authored: string, drawn = authored): boolean[] {
  const result: boolean[] = []
  const isConfirmed = createClosingFenceCheck(authored, drawn)
  visit(parser.parse(drawn), 'code', (node) => {
    result.push(
      node.data?.hProperties?.[MARKDOWN_CLOSING_FENCE] === 'true' && isConfirmed(node.position)
    )
  })
  return result
}

describe('authored HTML fence closure', () => {
  it.each([
    ['a split closer', '```html\n<html>\n``', false],
    ['a closer at the stream edge', '```html\n<html>\n```', false],
    ['a closer with a suffix', '```html\n<html>\n```suffix\n', false],
    ['a confirmed closer', '```html\n<html>\n```\n', true],
    ['a longer closer with CRLF', '```html\r\n<html>\r\n```` \r\nMore', true],
    ['mismatched markers', '~~~html\n<html>\n```\n', false],
    ['too few markers', '````html\n<html>\n```\n', false],
    ['a closed fence in a quote and list', '> - ~~~HTML\n>   <html>\n>   ~~~\n>   More', true],
    ['a quote ending without a closer', '> ```html\n> <html>\n\nMore', false],
    ['a list ending without a closer', '- ```html\n  <html>\n\nMore', false],
    ['a delimiter kept as indented code', '```html\n<html>\n    ```\n', false],
    ['an initial BOM', '\uFEFF~~~html\n<html>\n~~~\n', true]
  ])('recognizes %s', (_label, source, closed) => {
    expect(confirmed(source)).toEqual([closed])
  })

  it('requires the closing line to be present in the authored text', () => {
    const code = '> ```html\n> <html>\n> '
    expect(confirmed(`${code}\`\`junk\n`, `${code}\`\`\`\n`)).toEqual([false])
    expect(confirmed(`${code}\`\`\` \t\n> <div`, `${code}\`\`\``)).toEqual([true])
  })
})
