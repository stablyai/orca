import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Copy, Eye, ExternalLink, FileText, ListTree, Pencil, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from '../tab-bar/SortableTab'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import EditorViewToggle, {
  CSV_VIEW_MODE_METADATA,
  NOTEBOOK_VIEW_MODE_METADATA
} from './EditorViewToggle'
import type { EditorToggleValue } from './EditorViewToggle'
import type { EditorHeaderOpenFileState } from './editor-header'
import { getEditorHeaderCopyState } from './editor-header'
import { DiffNotesSendMenu } from './DiffNotesSendMenu'
import { useEditorHeaderFileRename } from './editor-header-file-rename'
import { EditorPanelMarkdownActionsMenu } from './EditorPanelMarkdownActionsMenu'
import { translate } from '@/i18n/i18n'

const isMac = navigator.userAgent.includes('Mac')
const isLinux = navigator.userAgent.includes('Linux')

/** Platform-appropriate label: macOS -> Finder, Windows -> File Explorer, Linux -> Files */
const revealLabel = isMac
  ? 'Reveal in Finder'
  : isLinux
    ? 'Open Containing Folder'
    : 'Reveal in File Explorer'

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
  canShowMarkdownFrontmatterToggle: boolean
  markdownFrontmatterVisible: boolean
  sideBySide: boolean
  openFileState: EditorHeaderOpenFileState
  onCopyPath: () => void
  onOpenDiffTargetFile: (preferredMarkdownViewMode?: 'rich') => void
  onOpenPreviewToSide: () => void
  onOpenMarkdownPreview: () => void
  onOpenContainingFolder: () => void
  onToggleSideBySide: () => void
  onEditorToggleChange: (next: EditorToggleValue) => void
  onToggleMarkdownTableOfContents: () => void
  onToggleMarkdownFrontmatter: () => void
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
  canShowMarkdownFrontmatterToggle,
  markdownFrontmatterVisible,
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
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf
}: EditorPanelHeaderProps): React.JSX.Element {
  const [pathMenuOpen, setPathMenuOpen] = useState(false)
  const [pathMenuPoint, setPathMenuPoint] = useState({ x: 0, y: 0 })
  const skipMenuFocusRestoreRef = useRef(false)
  const headerCopyState = getEditorHeaderCopyState(activeFile)
  const {
    canRename,
    currentFileName,
    isRenaming,
    renameInputRef,
    openRenameInput,
    commitRename,
    cancelRename
  } = useEditorHeaderFileRename(activeFile)
  const diffComments = useAppStore((s) => s.getDiffComments(activeFile.worktreeId))
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[activeFile.worktreeId])
  const fileDiffComments = useMemo(
    () => diffComments.filter((comment) => comment.filePath === activeFile.relativePath),
    [activeFile.relativePath, diffComments]
  )
  const markdownPreviewShortcutLabel = useShortcutLabel('editor.markdownPreview')

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
          {isRenaming ? (
            <Input
              ref={renameInputRef}
              data-editor-header-rename-input="true"
              aria-label={translate("auto.components.editor.EditorPanelHeader.1bb1e226ec", "Rename file {{value0}}", { value0: currentFileName })}
              defaultValue={currentFileName}
              // Why: the header is narrow in floating mode; this keeps the
              // edit field aligned with the path label without growing chrome.
              className="h-6 w-[16ch] min-w-[104px] max-w-full rounded-sm bg-input/40 px-1.5 py-0 font-mono text-xs text-foreground md:text-xs focus-visible:ring-[1px]"
              spellCheck={false}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.stopPropagation()
                  commitRename()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  event.stopPropagation()
                  cancelRename()
                }
              }}
              onBlur={commitRename}
            />
          ) : (
            <button
              type="button"
              className="editor-header-path"
              onClick={onCopyPath}
              title={headerCopyState.pathTitle}
            >
              {headerCopyState.pathLabel}
            </button>
          )}
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
          <DropdownMenuContent
            className="w-56"
            sideOffset={0}
            align="start"
            onCloseAutoFocus={(event) => {
              if (!skipMenuFocusRestoreRef.current) {
                return
              }
              skipMenuFocusRestoreRef.current = false
              event.preventDefault()
            }}
          >
            <DropdownMenuItem
              disabled={!canRename}
              onSelect={() => {
                skipMenuFocusRestoreRef.current = true
                openRenameInput()
              }}
            >
              <Pencil className="w-3.5 h-3.5 mr-1.5" />
              {translate("auto.components.editor.EditorPanelHeader.84cdc0794b", "Rename")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(activeFile.filePath)
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              {translate("auto.components.editor.EditorPanelHeader.7c08a1f990", "Copy Path")}</DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                void window.api.ui.writeClipboardText(activeFile.relativePath)
              }}
            >
              <Copy className="w-3.5 h-3.5 mr-1.5" />
              {translate("auto.components.editor.EditorPanelHeader.269ce4842b", "Copy Relative Path")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            {canShowMarkdownPreview && (
              <DropdownMenuItem onSelect={onOpenMarkdownPreview}>
                <Eye className="w-3.5 h-3.5 mr-1.5" />
                {translate("auto.components.editor.EditorPanelHeader.4157f3cbf3", "Open Markdown Preview")}<DropdownMenuShortcut>{markdownPreviewShortcutLabel}</DropdownMenuShortcut>
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
                onClick={() => onOpenDiffTargetFile(isMarkdown ? 'rich' : undefined)}
                aria-label={translate("auto.components.editor.EditorPanelHeader.a10d9b8337", "Open file")}
                disabled={!openFileState.canOpen}
              >
                <FileText size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {openFileState.canOpen
                ? isMarkdown
                  ? translate("auto.components.editor.EditorPanelHeader.f0fd4174b5", "Open file tab to use rich markdown editing")
                  : translate("auto.components.editor.EditorPanelHeader.9b80bbe1de", "Open file tab")
                : translate("auto.components.editor.EditorPanelHeader.c98ce191da", "This diff has no modified-side file to open")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isSingleDiff && fileDiffComments.length > 0 && (
        <DiffNotesSendMenu
          worktreeId={activeFile.worktreeId}
          groupId={activeGroupId ?? activeFile.worktreeId}
          comments={diffComments}
          filePath={activeFile.relativePath}
          showFileScope
          triggerLabel="AI notes"
          triggerCount={fileDiffComments.length}
          triggerClassName="h-6 shrink-0 gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] font-medium leading-none text-foreground/80 hover:bg-accent hover:text-foreground"
          iconClassName="size-3"
        />
      )}
      {canOpenPreviewToSide && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                onClick={onOpenPreviewToSide}
                aria-label={translate("auto.components.editor.EditorPanelHeader.fb8331694e", "Open Preview to the Side")}
              >
                <Eye size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate("auto.components.editor.EditorPanelHeader.fb8331694e", "Open Preview to the Side")}</TooltipContent>
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
              {sideBySide ? translate("auto.components.editor.EditorPanelHeader.94756f08ba", "Switch to inline diff") : translate("auto.components.editor.EditorPanelHeader.e836faacfa", "Switch to side-by-side diff")}
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
                aria-label={translate("auto.components.editor.EditorPanelHeader.5447c4f68f", "Table of Contents")}
                aria-pressed={showMarkdownTableOfContents}
              >
                <ListTree size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {isMarkdownTableOfContentsDisabled
                ? translate("auto.components.editor.EditorPanelHeader.146cb5473c", "Table of Contents is available in rich or preview mode")
                : translate("auto.components.editor.EditorPanelHeader.5447c4f68f", "Table of Contents")}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <EditorPanelMarkdownActionsMenu
        isMarkdown={isMarkdown}
        hasViewModeToggle={hasViewModeToggle}
        mdViewMode={mdViewMode}
        canShowMarkdownFrontmatterToggle={canShowMarkdownFrontmatterToggle}
        markdownFrontmatterVisible={markdownFrontmatterVisible}
        onToggleMarkdownFrontmatter={onToggleMarkdownFrontmatter}
        onExportMarkdownToPdf={onExportMarkdownToPdf}
      />
    </div>
  )
}
