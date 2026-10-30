import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import type { CommentMarkdownExtension } from '@/components/sidebar/CommentMarkdown'
import { translate } from '@/i18n/i18n'

// Override both images and links: the document renderer can upgrade GitHub links to media.
// Sanitization still runs, and Mermaid stays source-only rather than rendering embedded SVG.
const previewExtension: CommentMarkdownExtension = {
  remarkPlugins: [],
  sanitizeAttributes: {},
  components: {
    img: ({ alt }) => (
      <span className="text-muted-foreground">
        {translate(
          'components.native-chat.addressPreview.embeddedImageDisabled',
          'Embedded image not loaded'
        )}
        {alt ? `: ${alt}` : ''}
      </span>
    ),
    a: ({ children }) => <span>{children}</span>
  }
}

export default function NativeChatAddressPreviewMarkdown({
  content
}: {
  content: string
}): React.JSX.Element {
  return (
    <CommentMarkdown
      content={content}
      variant="document"
      renderMermaid={false}
      extension={previewExtension}
      className="text-sm leading-relaxed"
    />
  )
}
