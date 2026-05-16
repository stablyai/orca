import { type JSX } from 'react'
import { cn } from '@/lib/utils'
import ImageViewer from './ImageViewer'

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
          No preview
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
  // Why: in inline (single-column) mode the grid defaults to equal row
  // heights, which squishes each preview into half the panel. Using
  // minmax(32rem, 1fr) ensures content panes are tall enough to show a
  // full page, and overflow-y-auto lets the user scroll between them.
  // Empty "No preview" panes collapse to auto height.
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
        !sideBySide && !isIntrinsicLayout && 'overflow-y-auto'
      )}
      style={gridRowStyle}
    >
      <ImageDiffPane
        label="Original"
        content={originalContent}
        filePath={filePath}
        mimeType={mimeType}
        layout={layout}
      />
      <ImageDiffPane
        label="Modified"
        content={modifiedContent}
        filePath={filePath}
        mimeType={mimeType}
        layout={layout}
      />
    </div>
  )
}
