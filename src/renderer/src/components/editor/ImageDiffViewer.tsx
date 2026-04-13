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
  // Why: in inline (single-column) mode the grid defaults to equal row
  // heights. When one side is empty (e.g. a new untracked PDF), the "No
  // preview" pane would waste half the vertical space. Using `auto` for
  // empty panes lets them collapse to their content height so the pane
  // with the actual preview fills the remaining space.
  const gridRowStyle = !sideBySide
    ? {
        gridTemplateRows: `${originalContent ? '1fr' : 'auto'} ${modifiedContent ? '1fr' : 'auto'}`
      }
    : undefined

  return (
    <div
      className={`grid h-full min-h-0 gap-3 p-3 ${sideBySide ? 'grid-cols-2' : 'grid-cols-1'}`}
      style={gridRowStyle}
    >
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
