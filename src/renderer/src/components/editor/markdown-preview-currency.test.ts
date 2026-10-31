import { describe, expect, it } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Node } from 'unist'
import { MARKDOWN_REMARK_PLUGINS } from './markdown-preview-plugins'

function nodes(source: string): Node[] {
  const processor = unified().use(remarkParse).use(MARKDOWN_REMARK_PLUGINS)
  const tree = processor.runSync(processor.parse(source))
  const collect = (node: Node): Node[] => [
    node,
    ...('children' in node && Array.isArray(node.children) ? node.children.flatMap(collect) : [])
  ]
  return collect(tree)
}

describe('currency in Markdown preview', () => {
  it.each([
    'Costs $100 and $200.',
    'Costs $**100** and $200.',
    'Costs $100 and [details](https://example.com/$200).',
    'Escaped \\$100 and \\$200.',
    '$ x$',
    '$x $',
    '$\u00a0x$',
    '$x\t$',
    '$x\r\n$',
    '$x$2'
  ])('retains %j as ordinary Markdown', (source) => {
    expect(nodes(source).filter((node) => node.type === 'inlineMath')).toEqual([])
  })

  it('keeps valid math alongside currency and a code span', () => {
    const tree = nodes('Pay $100 and $200. Code `$100 and $200`. Math $x_1$.')
    expect(tree.filter((node) => node.type === 'inlineMath')).toMatchObject([{ value: 'x_1' }])
    expect(tree.filter((node) => node.type === 'inlineCode')).toMatchObject([
      { value: '$100 and $200' }
    ])
  })

  it('keeps Markdown formatting and destinations around dollar amounts', () => {
    const tree = nodes('Costs $**100** and $200. [Details](https://example.com/$200).')
    expect(tree.filter((node) => node.type === 'strong')).toHaveLength(1)
    expect(tree.filter((node) => node.type === 'link')).toMatchObject([
      { url: 'https://example.com/$200' }
    ])
  })

  it.each(['$2+2$', '$x y$', '$x\ny$', '$x\r\ny$', 'Inline $$ x $$ stays.'])(
    'retains supported inline math in %j',
    (source) => {
      expect(nodes(source).filter((node) => node.type === 'inlineMath')).toHaveLength(1)
    }
  )

  it('keeps display math and fenced code unchanged', () => {
    const tree = nodes('$$\nx^2\n$$\n\n```text\n$100 and $200\n```')
    expect(tree.filter((node) => node.type === 'math')).toMatchObject([{ value: 'x^2' }])
    expect(tree.filter((node) => node.type === 'code')).toMatchObject([{ value: '$100 and $200' }])
  })
})
