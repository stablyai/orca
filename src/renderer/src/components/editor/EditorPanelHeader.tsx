import { useMemo } from 'react'
import { Columns2, Eye, FileText, ListTree, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import EditorViewToggle, {
  CSV_VIEW_MODE_METADATA,
  NOTEBOOK_VIEW_MODE_METADATA
} from './EditorViewToggle'
import type { EditorToggleValue } from './EditorViewToggle'
import type { EditorHeaderOpenFileState } from './editor-header'
import { DiffNotesSendMenu } from './DiffNotesSendMenu'
import { EditorPanelMarkdownActionsMenu } from './EditorPanelMarkdownActionsMenu'
import { translate } from '@/i18n/i18n'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'

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
  canOpenPreviewToSide: boolean
  canShowMarkdownPreview: boolean
  canShowMarkdownTableOfContents: boolean
  isMarkdownTableOfContentsDisabled: boolean
  shouldShowMarkdownExportAction: boolean
  canExportMarkdownToPdf: boolean
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
  canOpenPreviewToSide,
  canShowMarkdownPreview,
  canShowMarkdownTableOfContents,
  isMarkdownTableOfContentsDisabled,
  shouldShowMarkdownExportAction,
  canExportMarkdownToPdf,
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
  const diffComments = useAppStore((s) => s.getDiffComments(activeFile.worktreeId))
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[activeFile.worktreeId])
  const fileDiffComments = useMemo(
    () => diffComments.filter((comment) => comment.filePath === activeFile.relativePath),
    [activeFile.relativePath, diffComments]
  )

  return (
    <div className="editor-header">
      <EditorPanelHeaderPath
        activeFile={activeFile}
        copiedPathVisible={copiedPathVisible}
        canShowMarkdownPreview={canShowMarkdownPreview}
        onCopyPath={onCopyPath}
        onOpenMarkdownPreview={onOpenMarkdownPreview}
        onOpenContainingFolder={onOpenContainingFolder}
      />
      {isSingleDiff && (
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={() => onOpenDiffTargetFile(isMarkdown ? 'rich' : undefined)}
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeader.a10d9b8337',
                  'Open file'
                )}
                disabled={!openFileState.canOpen}
              >
                <FileText size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {openFileState.canOpen
                ? isMarkdown
                  ? translate(
                      'auto.components.editor.EditorPanelHeader.f0fd4174b5',
                      'Open file tab to use rich markdown editing'
                    )
                  : translate(
                      'auto.components.editor.EditorPanelHeader.9b80bbe1de',
                      'Open file tab'
                    )
                : translate(
                    'auto.components.editor.EditorPanelHeader.c98ce191da',
                    'This diff has no modified-side file to open'
                  )}
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
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeader.fb8331694e',
                  'Open Preview to the Side'
                )}
              >
                <Eye size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.editor.EditorPanelHeader.fb8331694e',
                'Open Preview to the Side'
              )}
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
              {sideBySide
                ? translate(
                    'auto.components.editor.EditorPanelHeader.94756f08ba',
                    'Switch to inline diff'
                  )
                : translate(
                    'auto.components.editor.EditorPanelHeader.e836faacfa',
                    'Switch to side-by-side diff'
                  )}
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
                aria-label={translate(
                  'auto.components.editor.EditorPanelHeader.5447c4f68f',
                  'Table of Contents'
                )}
                aria-pressed={showMarkdownTableOfContents}
              >
                <ListTree size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {isMarkdownTableOfContentsDisabled
                ? translate(
                    'auto.components.editor.EditorPanelHeader.146cb5473c',
                    'Table of Contents is available in rich or preview mode'
                  )
                : translate(
                    'auto.components.editor.EditorPanelHeader.5447c4f68f',
                    'Table of Contents'
                  )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      <EditorPanelMarkdownActionsMenu
        isMarkdown={isMarkdown}
        shouldShowMarkdownExportAction={shouldShowMarkdownExportAction}
        canExportMarkdownToPdf={canExportMarkdownToPdf}
        canShowMarkdownFrontmatterToggle={canShowMarkdownFrontmatterToggle}
        markdownFrontmatterVisible={markdownFrontmatterVisible}
        onToggleMarkdownFrontmatter={onToggleMarkdownFrontmatter}
        onExportMarkdownToPdf={onExportMarkdownToPdf}
      />
    </div>
  )
}
