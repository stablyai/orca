import { translate } from '@/i18n/i18n'
import { isClipboardTextByteLengthOverLimit } from '../../../../shared/clipboard-text'
import { LARGE_MARKDOWN_PREVIEW_MAX_BYTES } from './markdown-preview-document-types'
import { formatBytes } from '../status-bar/workspace-space-format'

export function MarkdownPreviewSizeGate({
  content,
  isDiff = false,
  children
}: {
  content: string
  isDiff?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  if (!isClipboardTextByteLengthOverLimit(content, LARGE_MARKDOWN_PREVIEW_MAX_BYTES)) {
    return <>{children}</>
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <span>
        {isDiff
          ? translate(
              'editor.markdownPreview.tooLargeInDiff',
              'File is larger than the {{limit}} preview limit. Switch to source mode to view the diff.',
              { limit: formatBytes(LARGE_MARKDOWN_PREVIEW_MAX_BYTES) }
            )
          : translate(
              'editor.markdownPreview.tooLarge',
              'File is larger than the {{limit}} preview limit. Open the file to view its source.',
              { limit: formatBytes(LARGE_MARKDOWN_PREVIEW_MAX_BYTES) }
            )}
      </span>
    </div>
  )
}
