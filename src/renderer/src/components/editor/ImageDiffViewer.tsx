import type { JSX } from 'react'
import { cn } from '@/lib/utils'
import ImageViewer from './ImageViewer'
import { translate } from '@/i18n/i18n'

type ImageDiffViewerProps = {
  originalContent: string
  modifiedContent: string
  filePath: string
  mimeType?: string
  sideBySide: boolean
  layout?: 'fill' | 'intrinsic'
}

function ImageDiffPane({
  label,
  content,
  filePath,
  mimeType,
  layout
}: {
  label: string
  content: string
  filePath: string
  mimeType?: string
  layout: 'fill' | 'intrinsic'
}): JSX.Element {
  const isIntrinsicLayout = layout === 'intrinsic'

  if (!content) {
    return (
      <div
        className={cn(
          'flex min-h-0 flex-col overflow-hidden rounded-md bg-muted/10',
          isIntrinsicLayout ? 'h-auto' : 'h-full'
        )}
      >
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
        <div
          className={cn(
            'flex items-center justify-center bg-muted/20 p-6 text-sm text-muted-foreground',
            isIntrinsicLayout ? 'min-h-32' : 'flex-1'
          )}
        >
          {translate('auto.components.editor.ImageDiffViewer.fb0ae4f3c0', 'No preview')}
        </div>
      </div>
    )
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-md bg-muted/10',
        isIntrinsicLayout ? 'h-auto' : 'h-full'
      )}
    >
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
      <div className={cn('min-h-0', isIntrinsicLayout ? 'flex-none' : 'flex-1')}>
        <ImageViewer content={content} filePath={filePath} mimeType={mimeType} layout={layout} />
      </div>
    </div>
  )
}

export default function ImageDiffViewer({
  originalContent,
  modifiedContent,
  filePath,
  mimeType,
  sideBySide,
  layout = 'fill'
}: ImageDiffViewerProps): JSX.Element {
  const isIntrinsicLayout = layout === 'intrinsic'
  // Equal inline grid rows squash previews; give content a scrollable page-sized minimum while empty panes collapse.
  const gridRowStyle =
    !sideBySide && !isIntrinsicLayout
      ? {
          gridTemplateRows: `${originalContent ? 'minmax(32rem, 1fr)' : 'auto'} ${modifiedContent ? 'minmax(32rem, 1fr)' : 'auto'}`
        }
      : undefined

  return (
    <div
      className={cn(
        'grid min-h-0 gap-3 p-3',
        isIntrinsicLayout ? 'h-auto' : 'h-full',
        sideBySide ? 'grid-cols-2' : 'grid-cols-1',
        !sideBySide && !isIntrinsicLayout && 'overflow-y-auto scrollbar-editor'
      )}
      style={gridRowStyle}
    >
      <ImageDiffPane
        label={translate('auto.components.editor.ImageDiffViewer.57aac3979a', 'Original')}
        content={originalContent}
        filePath={filePath}
        mimeType={mimeType}
        layout={layout}
      />
      <ImageDiffPane
        label={translate('auto.components.editor.ImageDiffViewer.a651be62b0', 'Modified')}
        content={modifiedContent}
        filePath={filePath}
        mimeType={mimeType}
        layout={layout}
      />
    </div>
  )
}
