import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { RICH_MARKDOWN_MAX_SIZE_BYTES } from '../../../../shared/constants'
import { formatBytes } from '../status-bar/workspace-space-format'
import {
  canRenderMarkdownAtSize,
  exceedsMarkdownRenderOverrideSizeLimit
} from './markdown-rich-size-limit'

// Why: the preview renders the whole document synchronously (react-markdown +
// rehype, no virtualization), so a multi-MB file blocks the renderer for tens
// of seconds and pushes it past 1 GB. Gate it like the rich editor's size fallback.
export function MarkdownPreviewSizeGate({
  previewTabId,
  content,
  isDiff = false,
  children
}: {
  previewTabId: string
  content: string
  isDiff?: boolean
  children: React.ReactNode
}): React.JSX.Element {
  const sizeOverridden = useAppStore((s) => s.markdownRichModeSizeOverride[previewTabId] === true)
  const setSizeOverride = useAppStore((s) => s.setMarkdownRichModeSizeOverride)
  if (canRenderMarkdownAtSize(content, sizeOverridden)) {
    return <>{children}</>
  }
  const canOverrideSize = !exceedsMarkdownRenderOverrideSizeLimit(content)
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground">
      <span>
        {isDiff
          ? translate(
              'editor.markdownPreview.tooLargeInDiff',
              'File is larger than the {{limit}} preview limit. Switch to source mode to view the diff.',
              { limit: formatBytes(RICH_MARKDOWN_MAX_SIZE_BYTES) }
            )
          : translate(
              'editor.markdownPreview.tooLarge',
              'File is larger than the {{limit}} preview limit. Open the file to view its source.',
              { limit: formatBytes(RICH_MARKDOWN_MAX_SIZE_BYTES) }
            )}
      </span>
      {canOverrideSize ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          onClick={() => setSizeOverride(previewTabId, true)}
        >
          {translate('editor.markdownPreview.renderAnyway', 'Render anyway')}
        </Button>
      ) : null}
    </div>
  )
}
