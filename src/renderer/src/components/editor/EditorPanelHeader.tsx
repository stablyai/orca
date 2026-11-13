import { useMemo } from 'react'
import { ArrowDown, ArrowUp, Columns2, Eye, FileText, ListTree, Rows2 } from 'lucide-react'
import { useAppStore } from '@/store'
import { useVisibleWorktreeDiffComments } from '../diff-comments/use-visible-worktree-diff-comments'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import EditorViewToggle, {
  CSV_VIEW_MODE_METADATA,
  CUSTOM_EDITOR_SOURCE_METADATA,
  NOTEBOOK_VIEW_MODE_METADATA,
  SVG_VIEW_MODE_METADATA
} from './view-mode/EditorViewToggle'
import type { CustomEditorToggleValue, EditorToggleValue } from './view-mode/EditorViewToggle'
import { MarkdownDefaultViewContextMenu } from './view-mode/MarkdownDefaultViewContextMenu'
import type { EditorHeaderOpenFileState } from './editor-header'
import { DiffNotesSendMenu } from './diff/review/DiffNotesSendMenu'
import { EditorPanelActionsMenu } from './EditorPanelActionsMenu'
import { EditorFileLocationMenuItems } from './EditorFileLocationMenuItems'
import { useTranslate } from '@/i18n/use-translate'
import { EditorPanelHeaderPath } from './EditorPanelHeaderPath'
import { useDiffNavigation } from './diff/review/diff-navigation-context'
import { useShortcutKeyDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import type { ArtifactWriteRequest } from '../../../../shared/artifacts/artifacts'
import { ArtifactPublishButton } from '@/components/artifacts/ArtifactPublishButton'
import { editorArtifactSourceKey } from './editor-artifact-upload'

const NO_CUSTOM_EDITOR_TITLES: Readonly<Record<CustomEditorToggleValue, string>> = {}

type EditorPanelHeaderProps = {
  activeFile: OpenFile
  copiedPathVisible: boolean
  isSingleDiff: boolean
  isDiffSurface: boolean
  isMarkdown: boolean
  isCsv: boolean
  isNotebook: boolean
  isSvg?: boolean
  /** Titles of the file's plugin editors, by toggle value; empty when none apply. */
  customEditorTitles?: Readonly<Record<CustomEditorToggleValue, string>>
  hasEditorToggle: boolean
  availableEditorToggleModes: readonly EditorToggleValue[]
  effectiveToggleValue: EditorToggleValue
  canOpenPreview: boolean
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
  onOpenPreview: () => void
  onOpenMarkdownPreview: () => void
  onToggleSideBySide: () => void
  onEditorToggleChange: (next: EditorToggleValue) => void
  onToggleMarkdownTableOfContents: () => void
  onToggleMarkdownFrontmatter: () => void
  onExportMarkdownToPdf: () => void
  createArtifactRequest?: () => Promise<ArtifactWriteRequest>
}

export function EditorPanelHeader({
  activeFile,
  copiedPathVisible,
  isSingleDiff,
  isDiffSurface,
  isMarkdown,
  isCsv,
  isNotebook,
  isSvg = false,
  customEditorTitles = NO_CUSTOM_EDITOR_TITLES,
  hasEditorToggle,
  availableEditorToggleModes,
  effectiveToggleValue,
  canOpenPreview,
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
  onOpenPreview,
  onOpenMarkdownPreview,
  onToggleSideBySide,
  onEditorToggleChange,
  onToggleMarkdownTableOfContents,
  onToggleMarkdownFrontmatter,
  onExportMarkdownToPdf,
  createArtifactRequest
}: EditorPanelHeaderProps): React.JSX.Element {
  const t = useTranslate()
  const { owner: commentOwner, comments: diffComments } = useVisibleWorktreeDiffComments(
    activeFile.worktreeId,
    activeFile
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[activeFile.worktreeId])
  const diffWordWrap = useAppStore((s) => s.settings?.diffWordWrap === true)
  const diffShowWhitespace = useAppStore((s) => s.settings?.diffShowWhitespace === true)
  const editorWordWrap = useAppStore((s) => s.settings?.editorWordWrap !== false)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const fileDiffComments = useMemo(
    () => diffComments.filter((comment) => comment.filePath === activeFile.relativePath),
    [activeFile.relativePath, diffComments]
  )
  const { changeCount, goToPreviousDiff, goToNextDiff } = useDiffNavigation()
  const previousChangeShortcut = useShortcutKeyDetails('editor.previousChange')
  const nextChangeShortcut = useShortcutKeyDetails('editor.nextChange')

  // Why: Markdown edit tabs expose the default view on right-click; other files keep a plain switcher.
  const canSetMarkdownDefaultView = isMarkdown && activeFile.mode === 'edit'
  const editorViewToggle = (
    <EditorViewToggle
      value={effectiveToggleValue}
      modes={availableEditorToggleModes}
      onChange={onEditorToggleChange}
      metadataOverride={
        isCsv
          ? CSV_VIEW_MODE_METADATA
          : isNotebook
            ? NOTEBOOK_VIEW_MODE_METADATA
            : isSvg
              ? SVG_VIEW_MODE_METADATA
              : Object.keys(customEditorTitles).length > 0
                ? CUSTOM_EDITOR_SOURCE_METADATA
                : undefined
      }
      customEditorTitles={customEditorTitles}
    />
  )

  return (
    <div className="editor-header">
      <EditorPanelHeaderPath
        activeFile={activeFile}
        copiedPathVisible={copiedPathVisible}
        canShowMarkdownPreview={canShowMarkdownPreview}
        onCopyPath={onCopyPath}
        onOpenMarkdownPreview={onOpenMarkdownPreview}
      />
      {canOpenPreview && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
                onClick={onOpenPreview}
                aria-label={t('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')}
              >
                <Eye size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('auto.components.editor.EditorViewToggle.0d193dc03c', 'Preview')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isSingleDiff && (
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={() => onOpenDiffTargetFile(isMarkdown ? 'rich' : undefined)}
                aria-label={t('auto.components.editor.EditorPanelHeader.a10d9b8337', 'Open file')}
                disabled={!openFileState.canOpen}
              >
                <FileText size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {openFileState.canOpen
                ? isMarkdown
                  ? t(
                      'auto.components.editor.EditorPanelHeader.f0fd4174b5',
                      'Open file tab to use rich markdown editing'
                    )
                  : t('auto.components.editor.EditorPanelHeader.9b80bbe1de', 'Open file tab')
                : t(
                    'auto.components.editor.EditorPanelHeader.c98ce191da',
                    'This diff has no modified-side file to open'
                  )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {isSingleDiff && fileDiffComments.length > 0 && (
        <DiffNotesSendMenu
          owner={commentOwner}
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
      {isDiffSurface && (
        <TooltipProvider>
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
                ? t('auto.components.editor.EditorPanelHeader.94756f08ba', 'Switch to inline diff')
                : t(
                    'auto.components.editor.EditorPanelHeader.e836faacfa',
                    'Switch to side-by-side diff'
                  )}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={goToPreviousDiff}
                aria-label={t(
                  'auto.components.editor.EditorPanelHeader.2076ecfc9c',
                  'Previous change'
                )}
                disabled={changeCount === 0}
              >
                <ArrowUp size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('auto.components.editor.EditorPanelHeader.2076ecfc9c', 'Previous change')}
              {previousChangeShortcut.keys.length > 0 && (
                <ShortcutKeyCombo
                  keys={previousChangeShortcut.keys}
                  doubleTap={previousChangeShortcut.doubleTap}
                  className="ml-1.5"
                />
              )}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors flex-shrink-0 disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                onClick={goToNextDiff}
                aria-label={t('auto.components.editor.EditorPanelHeader.631dab0df3', 'Next change')}
                disabled={changeCount === 0}
              >
                <ArrowDown size={14} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {t('auto.components.editor.EditorPanelHeader.631dab0df3', 'Next change')}
              {nextChangeShortcut.keys.length > 0 && (
                <ShortcutKeyCombo
                  keys={nextChangeShortcut.keys}
                  doubleTap={nextChangeShortcut.doubleTap}
                  className="ml-1.5"
                />
              )}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {hasEditorToggle &&
        !activeFile.csvPreviewOnly &&
        (canSetMarkdownDefaultView ? (
          <MarkdownDefaultViewContextMenu onSelectView={onEditorToggleChange}>
            {editorViewToggle}
          </MarkdownDefaultViewContextMenu>
        ) : (
          editorViewToggle
        ))}
      {canShowMarkdownTableOfContents && (
        <TooltipProvider>
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
                aria-label={t(
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
                ? t(
                    'auto.components.editor.EditorPanelHeader.146cb5473c',
                    'Table of Contents is available in rich or preview mode'
                  )
                : t('auto.components.editor.EditorPanelHeader.5447c4f68f', 'Table of Contents')}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
      {!isDiffSurface && createArtifactRequest ? (
        <ArtifactPublishButton
          sourceKey={editorArtifactSourceKey(activeFile)}
          className="size-6 [&_svg]:size-3.5!"
          createRequest={createArtifactRequest}
        />
      ) : null}
      <EditorPanelActionsMenu
        fileLocationActions={
          activeFile.mode === 'edit' ||
          activeFile.mode === 'markdown-preview' ||
          (isSingleDiff && openFileState.canOpen) ? (
            <EditorFileLocationMenuItems file={activeFile} onCopyPath={onCopyPath} />
          ) : undefined
        }
        isDiffSurface={isDiffSurface}
        diffWordWrap={diffWordWrap}
        diffShowWhitespace={diffShowWhitespace}
        editorWordWrap={editorWordWrap}
        shouldShowMarkdownExportAction={shouldShowMarkdownExportAction}
        canExportMarkdownToPdf={canExportMarkdownToPdf}
        canShowMarkdownFrontmatterToggle={canShowMarkdownFrontmatterToggle}
        markdownFrontmatterVisible={markdownFrontmatterVisible}
        onToggleDiffWordWrap={() => void updateSettings({ diffWordWrap: !diffWordWrap })}
        onToggleDiffWhitespace={() =>
          void updateSettings({ diffShowWhitespace: !diffShowWhitespace })
        }
        onToggleEditorWordWrap={() => void updateSettings({ editorWordWrap: !editorWordWrap })}
        onToggleMarkdownFrontmatter={onToggleMarkdownFrontmatter}
        onExportMarkdownToPdf={onExportMarkdownToPdf}
      />
    </div>
  )
}
