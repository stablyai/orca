import { renderToStaticMarkup } from 'react-dom/server'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import { describe, expect, it } from 'vitest'
import { markdownPreviewSanitizeSchema } from './markdown-preview-sanitize-schema'
import { RICH_MARKDOWN_TEXT_COLORS } from './rich-markdown-text-color-palette'

function renderSanitizedMarkdown(content: string): string {
  return renderToStaticMarkup(
    <Markdown rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownPreviewSanitizeSchema]]}>
      {content}
    </Markdown>
  )
}

describe('markdown preview text color sanitization', () => {
  it.each(RICH_MARKDOWN_TEXT_COLORS)(
    'keeps the controlled %s text color and removes style attributes',
    (color) => {
      const html = renderSanitizedMarkdown(
        `<span data-orca-text-color="${color}" style="font-size: 100px">safe</span>`
      )
      expect(html).toContain(`<span data-orca-text-color="${color}">safe</span>`)
      expect(html).not.toContain('style=')
    }
  )

  it('removes unsupported text colors', () => {
    const html = renderSanitizedMarkdown('<span data-orca-text-color="cyan">plain</span>')
    expect(html).toContain('<span>plain</span>')
    expect(html).not.toContain('data-orca-text-color')
  })
})
