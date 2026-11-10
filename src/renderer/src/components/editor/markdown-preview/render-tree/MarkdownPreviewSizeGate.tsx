import { useTranslate } from '@/i18n/use-translate'
import { isClipboardTextByteLengthOverLimit } from '../../../../../../shared/clipboard-text'
import { LARGE_MARKDOWN_PREVIEW_MAX_BYTES } from '../document-worker/markdown-preview-document-types'
import '../../../status-bar/workspace-space-format'
import { formatBytes } from '../../../../../../shared/format-bytes'

export function MarkdownPreviewSizeGate({
  content,
  isDiff = false,
  children
}: {
  content: string
  isDiff?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  if (!isClipboardTextByteLengthOverLimit(content, LARGE_MARKDOWN_PREVIEW_MAX_BYTES)) {
    return <>{children}</>
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <span>
        {isDiff
          ? t(
              'editor.markdownPreview.tooLargeInDiff',
              'File is larger than the {{limit}} preview limit. Switch to source mode to view the diff.',
              { limit: formatBytes(LARGE_MARKDOWN_PREVIEW_MAX_BYTES) }
            )
          : t(
              'editor.markdownPreview.tooLarge',
              'File is larger than the {{limit}} preview limit. Open the file to view its source.',
              { limit: formatBytes(LARGE_MARKDOWN_PREVIEW_MAX_BYTES) }
            )}
      </span>
    </div>
  )
}
