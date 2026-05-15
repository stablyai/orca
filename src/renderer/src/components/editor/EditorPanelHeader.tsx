import { useEffect, useState } from 'react'
import {
  Columns2,
  Copy,
  Eye,
  ExternalLink,
  FileText,
  ListTree,
  MoreHorizontal,
  Rows2
} from 'lucide-react'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab'
import EditorViewToggle, {
  CSV_VIEW_MODE_METADATA,
  NOTEBOOK_VIEW_MODE_METADATA
} from './EditorViewToggle'
import type { EditorToggleValue } from './EditorViewToggle'
import type { EditorHeaderOpenFileState } from './editor-header'
import { getEditorHeaderCopyState } from './editor-header'
import { getMarkdownPreviewShortcutLabel } from './markdown-preview-controls'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS -> Finder, Windows -> File Explorer, Linux -> Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'
const markdownPreviewShortcutLabel = getMarkdownPreviewShortcutLabel(isMac)

type EditorPanelHeaderProps = {
  activeFile: OpenFile
  copiedPathVisible: boolean
  isSingleDiff: boolean
  isDiffSurface: boolean
  isMarkdown: boolean
  isCsv: boolean
  isNotebook: boolean
  hasEditorToggle: boolean
  availableEditorToggleModes: readonly EditorToggleValue[]
  effectiveToggleValue: EditorToggleValue
  mdViewMode: MarkdownViewMode
  hasViewModeToggle: boolean
  canOpenPreviewToSide: boolean
  canShowMarkdownPreview: boolean
  canShowMarkdownTableOfContents: boolean
  isMarkdownTableOfContentsDisabled: boolean
  showMarkdownTableOfContents: boolean
  markdownReviewToolsEnabled: boolean
  sideBySide: boolean
  openFileState: EditorHeaderOpenFileState
  onCopyPath: () => void
  onOpenDiffTargetFile: () => void
  onOpenPreviewToSide: () => void
  onOpenMarkdownPreview: () => void
  onOpenContainingFolder: () => void
  onToggleSideBySide: () => void
  onEditorToggleChange: (next: EditorToggleValue) => void
  onToggleMarkdownTableOfContents: () => void
  onToggleMarkdownReviewTools: () => void
  onExportMarkdownToPdf: () => void
}

export function EditorPanelHeader({
  activeFile,
  copiedPathVisible,
  isSingleDiff,
  isDiffSurface,
  isMarkdown,
  isCsv,
  isNotebook,
  hasEditorToggle,
  availableEditorToggleModes,
  effectiveToggleValue,
  mdViewMode,
  hasViewModeToggle,
  canOpenPreviewToSide,
  canShowMarkdownPreview,
  canShowMarkdownTableOfContents,
  isMarkdownTableOfContentsDisabled,
  showMarkdownTableOfContents,
  markdownReviewToolsEnabled,
  sideBySide,
  openFileState,
  onCopyPath,
  onOpenDiffTargetFile,
  onOpenPreviewToSide,
  onOpenMarkdownPreview,
  onOpenContainingFolder,
  onToggleSideBySide,
  onEditorToggleChange,
  onToggleMarkdownTableOfContents,
  onToggleMarkdownReviewTools,
  onExportMarkdownToPdf
}: EditorPanelHeaderProps): React.JSX.Element {
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 })
  const headerCopyState = getEditorHeaderCopyState(activeFile)

  useEffect(() => {
    const closeMenu = (): void => setPathMenuOpen(false)
    window.addEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
    return () => window.removeEventListener(CLOSE_ALL_CONTEXT_MENUS_EVENT, closeMenu)
  }, [])

  return (
    <div className="editor-header">
      <div className="editor-header-text">
        <div
          className="editor-header-path-row"
          onContextMenuCapture={(event) => {
            event.preventDefault()
            window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
            setPathMenuPoint({ x: event.clientX, y: event.clientY })
            setPathMenuOpen(true)
          }}
        >
          <button
            type="button"
            className="editor-header-path"
            onClick={onCopyPath}
            title={headerCopyState.pathTitle}
          >
            {headerCopyState.pathLabel}
          </button>
          <span
            className={`editor-header-copy-toast${copiedPathVisible ? ' is-visible' : ''}`}
            aria-live="polite"
          >
            {headerCopyState.copyToastLabel}
          </span>
        </div>
        <DropdownMenu open={pathMenuOpen} onOpenChange={setPathMenuOpen} modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none fixed size-px opacity-0"
              style={{ left: pathMenuPoint.x, top: pathMenuPoint.y }}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56" sideOffset={0} align="start">
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(activeFile.filePath)
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy Path
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(activeFile.relativePath)
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              Copy Relative Path
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {canShowMarkdownPreview && (
              <DropdownMenuItem onSelect={onOpenMarkdownPreview}>
                <Eye className="w-3.5 h-3.5 mr-1.5" />
                Open Markdown Preview
                <DropdownMenuShortcut>{markdownPreviewShortcutLabel}</DropdownMenuShortcut>
              </DropdownMenuItem>
            )}
            {canShowMarkdownPreview && <DropdownMenuSeparator />}
            <DropdownMenuItem onSelect={onOpenContainingFolder}>
              <ExternalLink className="w-3.5 h-3.5 mr-1.5" />
              {revealLabel}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isSingleDiff && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={onOpenDiffTargetFile}
                aria-label="Open file"
                disabled={!openFileState.canOpen}
              >
                <FileText size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {openFileState.canOpen
                ? isMarkdown
                  ? 'Open file tab to use rich markdown editing'
                  : 'Open file tab'
                : 'This diff has no modified-side file to open'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {canOpenPreviewToSide && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                onClick={onOpenPreviewToSide}
                aria-label="Open Preview to the Side"
              >
                <Eye size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              Open Preview to the Side
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isDiffSurface && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                onClick={onToggleSideBySide}
              >
                {sideBySide ? <Rows2 size={14} /> : <Columns2 size={14} />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {sideBySide ? 'Switch to inline diff' : 'Switch to side-by-side diff'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasEditorToggle && (
        <EditorViewToggle
          value={effectiveToggleValue}
          modes={availableEditorToggleModes}
          onChange={onEditorToggleChange}
          metadataOverride={
            isCsv ? CSV_VIEW_MODE_METADATA : isNotebook ? NOTEBOOK_VIEW_MODE_METADATA : undefined
          }
        />
      )}
      {canShowMarkdownTableOfContents && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={`p-1 rounded hover:bg-accent hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground ${
                  showMarkdownTableOfContents && !isMarkdownTableOfContentsDisabled
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground'
                }`}
                onClick={onToggleMarkdownTableOfContents}
                disabled={isMarkdownTableOfContentsDisabled}
                aria-label="Table of Contents"
                aria-pressed={showMarkdownTableOfContents}
              >
                <ListTree size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {isMarkdownTableOfContentsDisabled
                ? 'Table of Contents is available in rich or preview mode'
                : 'Table of Contents'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasViewModeToggle && isMarkdown && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
              aria-label="More actions"
              title="More actions"
            >
              <MoreHorizontal size={14} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={4}>
            <DropdownMenuItem
              // Why: the item is disabled (not hidden) only in source/Monaco
              // mode, which has no document DOM to export. We intentionally
              // don't poll the DOM (canExportActiveMarkdown) at render time:
              // the Radix content renders in a Portal and the lookup can
              // race with the active surface's paint, producing a stuck
              // disabled state. exportActiveMarkdownToPdf is a safe no-op
              // when no subtree is found.
              disabled={mdViewMode === 'source'}
              onSelect={onExportMarkdownToPdf}
            >
              Export as PDF
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onToggleMarkdownReviewTools}>
              {markdownReviewToolsEnabled ? 'Hide Review Notes' : 'Show Review Notes'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  )
}
