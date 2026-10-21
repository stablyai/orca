import { renderToStaticMarkup } from 'react-dom/server'
import remarkCjkFriendly from 'remark-cjk-friendly/parseOnly'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { describe, expect, it } from 'vitest'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'

const cjkEmphasisExamples = [
  {
    name: 'Korean text after a quoted phrase',
    markdown: '**"이런"**것은 강조됩니다.',
    expectedHtml: '<strong>&quot;이런&quot;</strong>것은 강조됩니다.'
  },
  {
    name: 'Korean text after parentheses',
    markdown: '**(강조)**입니다.',
    expectedHtml: '<strong>(강조)</strong>입니다.'
  },
  {
    name: 'Korean text on both delimiter boundaries',
    markdown: '문장은**"여기"**에서 이어집니다.',
    expectedHtml: '문장은<strong>&quot;여기&quot;</strong>에서 이어집니다.'
  },
  {
    name: 'Japanese text after corner brackets',
    markdown: '**「強調」**です。',
    expectedHtml: '<strong>「強調」</strong>です。'
  },
  {
    name: 'Chinese text after quotation marks',
    markdown: '**“强调”**文本',
    expectedHtml: '<strong>“强调”</strong>文本'
  }
]

const unchangedMarkdownExamples = [
  '# Heading',
  '**bold** text and *italic* text',
  'foo_bar_baz',
  '`**literal**`',
  '[link](https://example.com)',
  '- [x] completed task',
  '| left | right |\n| --- | --- |\n| a | b |',
  '~~deleted~~ text',
  '~~"삭제"~~문장'
]

function parseMarkdown(markdown: string) {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown)
}

function parseCjkFriendlyMarkdown(markdown: string) {
  return unified().use(remarkParse).use(remarkGfm).use(remarkCjkFriendly).parse(markdown)
}

describe('MarkdownPreviewBody', () => {
  it.each(cjkEmphasisExamples)('renders emphasis for $name', ({ markdown, expectedHtml }) => {
    const html = renderToStaticMarkup(<MarkdownPreviewBody content={markdown} components={{}} />)

    expect(html).toContain(expectedHtml)
  })

  it.each(unchangedMarkdownExamples)('keeps existing parsing for %s', (markdown) => {
    expect(parseCjkFriendlyMarkdown(markdown)).toEqual(parseMarkdown(markdown))
  })
})
