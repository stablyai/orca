import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { expect, it } from 'vitest'
import { commentMarkdownParsePlugins } from './comment-markdown-parse-plugins'

type Node = { type: string; value?: string; url?: string; children?: Node[] }

function inline(markdown: string): string {
  const processor = unified().use(remarkParse).use(commentMarkdownParsePlugins)
  const show = (node: Node): string => {
    const children = (node.children ?? []).map(show).join('')
    if (node.type === 'text') {
      return node.value ?? ''
    }
    return node.type === 'link' ? `link(${node.url})` : `${node.type}(${children})`
  }
  return show(processor.runSync(processor.parse(markdown), markdown))
}

it('pairs emphasis around a bare url cut at CJK punctuation', () => {
  expect(inline('下载：**https://example.com/ujes/**（2026-10-23 已上线）。')).toBe(
    'root(paragraph(下载：strong(link(https://example.com/ujes/))（2026-10-23 已上线）。))'
  )
  expect(inline('_https://a.com/x_。***https://b.com/y***、')).toBe(
    'root(paragraph(emphasis(link(https://a.com/x))。emphasis(strong(link(https://b.com/y)))、))'
  )
  expect(inline('见_https://example.com/a_。')).toBe(
    'root(paragraph(见_link(https://example.com/a)_。))'
  )
  expect(inline('**https://a.com/x&ast;&ast;（y）_https://b.com/z&lowbar;。')).toBe(
    'root(paragraph(**link(https://a.com/x)**（y）_link(https://b.com/z)_。))'
  )
})
