import { memo } from 'react'
import Markdown, { type Components } from 'react-markdown'
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_REHYPE_PLUGINS } from './markdown-preview-plugins'
import { markdownPreviewUrlTransform } from './markdown-preview-url-transform'

// Why: find-state renders must not rebuild the full remark/rehype pipeline.
export const MarkdownPreviewBody = memo(function MarkdownPreviewBody({
  content,
  components
}: {
  content: string
  components: Components
}) {
  return (
    <Markdown
      components={components}
      urlTransform={markdownPreviewUrlTransform}
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
    >
      {content}
    </Markdown>
  )
})
