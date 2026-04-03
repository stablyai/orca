import { type JSX } from 'react'
import ImageViewer from './ImageViewer'

type ImageDiffViewerProps = {
  originalContent: string
  modifiedContent: string
  filePath: string
  mimeType?: string
  sideBySide: boolean
}

function ImageDiffPane({
  label,
  content,
  filePath,
  mimeType
}: {
  label: string
  content: string
  filePath: string
  mimeType?: string
}): JSX.Element {
  if (!content) {
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-muted/10">
        <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
        <div className="flex flex-1 items-center justify-center bg-muted/20 p-6 text-sm text-muted-foreground">
          No preview
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md bg-muted/10">
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground">{label}</div>
      <div className="min-h-0 flex-1">
        <ImageViewer content={content} filePath={filePath} mimeType={mimeType} />
      </div>
    </div>
  )
}

export default function ImageDiffViewer({
  originalContent,
  modifiedContent,
  filePath,
  mimeType,
  sideBySide
}: ImageDiffViewerProps): JSX.Element {
  return (
    <div className={`grid h-full min-h-0 gap-3 p-3 ${sideBySide ? 'grid-cols-2' : 'grid-cols-1'}`}>
      <ImageDiffPane
        label="Original"
        content={originalContent}
        filePath={filePath}
        mimeType={mimeType}
      />
      <ImageDiffPane
        label="Modified"
        content={modifiedContent}
        filePath={filePath}
        mimeType={mimeType}
      />
    </div>
  )
}
