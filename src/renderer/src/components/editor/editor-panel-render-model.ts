import { detectLanguage } from '@/lib/language-detect'
import { canPreviewLanguage } from '@/lib/file-preview'
import type { useAppStore } from '@/store'
import type { MarkdownViewMode, OpenFile } from '@/store/slices/editor'
import {
  canOpenMarkdownPreview,
  getDefaultMarkdownViewMode,
  getEditorToggleModes,
  getMarkdownViewModes
} from './markdown-preview-controls'
import { getEditorHeaderOpenFileState } from './editor-header'
import type { EditorToggleValue } from './EditorViewToggle'
import type { FileContent } from './editor-panel-content-types'
import { canUseChangesModeForFile } from './editor-panel-file-mode'
import { getMarkdownRenderMode } from './markdown-render-mode'
import { getMarkdownRichModeUnsupportedMessage } from './markdown-rich-mode'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'

type StoreState = ReturnType<typeof useAppStore.getState>

type EditorPanelRenderModelParams = {
  activeFile: OpenFile
  fileContents: Record<string, FileContent>
  editorDrafts: StoreState['editorDrafts']
  gitStatusEntries: StoreState['gitStatusByWorktree'][string] | undefined
  gitBranchEntries: StoreState['gitBranchChangesByWorktree'][string] | undefined
  markdownViewMode: StoreState['markdownViewMode']
  isChangesMode: boolean
}

export function getEditorPanelRenderModel({
  activeFile,
  fileContents,
  editorDrafts,
  gitStatusEntries,
  gitBranchEntries,
  markdownViewMode,
  isChangesMode
}: EditorPanelRenderModelParams) {
  const isSingleDiff =
    activeFile.mode === 'diff' &&
    activeFile.diffSource !== undefined &&
    activeFile.diffSource !== 'combined-all' &&
    activeFile.diffSource !== 'combined-uncommitted' &&
    activeFile.diffSource !== 'combined-branch' &&
    activeFile.diffSource !== 'combined-commit'
  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-all' ||
      activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch' ||
      activeFile.diffSource === 'combined-commit')
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(activeFile.filePath)
  // Why: an AI Vault View Log tab must show the exact raw bytes read-only. A
  // rich/preview/mermaid/csv/notebook renderer would depart from raw text (and
  // can look editable), so neutralize specialized viewers + view-mode chrome
  // for read-only tabs. `resolvedLanguage` still drives read-only Monaco
  // tokenization (e.g. jsonl stays colorized); only viewer selection is forced
  // to a plain source rendering here.
  const rawReadOnly = activeFile.mode === 'edit' && activeFile.readOnly === true
  const viewerLanguage = rawReadOnly ? 'plaintext' : resolvedLanguage
  const worktreeEntries = gitStatusEntries ?? []
  const branchEntries = gitBranchEntries ?? []
  const matchingWorktreeEntry =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'staged' || activeFile.diffSource === 'unstaged')
      ? (worktreeEntries.find(
          (entry) =>
            entry.path === activeFile.relativePath &&
            (activeFile.diffSource === 'staged'
              ? entry.area === 'staged'
              : entry.area === 'unstaged')
        ) ?? null)
      : null
  const matchingBranchEntry =
    activeFile.mode === 'diff' && activeFile.diffSource === 'branch'
      ? (branchEntries.find((entry) => entry.path === activeFile.relativePath) ?? null)
      : null
  const openFileState = getEditorHeaderOpenFileState(
    activeFile,
    matchingWorktreeEntry,
    matchingBranchEntry
  )
  const markdownViewModes = getMarkdownViewModes({
    language: viewerLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const hasViewModeToggle = markdownViewModes.length > 0
  const defaultMarkdownViewMode = getDefaultMarkdownViewMode({
    language: viewerLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const storedMarkdownViewMode = markdownViewMode[activeFile.id]
  const mdViewMode: MarkdownViewMode =
    hasViewModeToggle &&
    storedMarkdownViewMode !== undefined &&
    markdownViewModes.includes(storedMarkdownViewMode)
      ? storedMarkdownViewMode
      : defaultMarkdownViewMode
  const editorToggleModes = getEditorToggleModes({
    language: viewerLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const isBinaryEditSurface =
    activeFile.mode === 'edit' && fileContents[activeFile.id]?.isBinary === true
  const availableEditorToggleModes =
    isBinaryEditSurface || !canUseChangesModeForFile(activeFile)
      ? editorToggleModes.filter((mode) => mode !== 'changes')
      : editorToggleModes
  const effectiveToggleValue: EditorToggleValue = isChangesMode
    ? 'changes'
    : hasViewModeToggle
      ? mdViewMode
      : 'edit'
  const inlineMarkdownContent =
    activeFile.mode === 'edit'
      ? (editorDrafts[activeFile.id] ?? fileContents[activeFile.id]?.content ?? null)
      : null
  const shouldShowMarkdownExportAction =
    viewerLanguage === 'markdown' &&
    (activeFile.mode === 'edit' || activeFile.mode === 'markdown-preview')
  const inlineMarkdownRenderMode =
    activeFile.mode === 'edit' && inlineMarkdownContent !== null
      ? getMarkdownRenderMode({
          exceedsRichModeSizeLimit: exceedsMarkdownRichModeSizeLimit(inlineMarkdownContent),
          hasRichModeUnsupportedContent:
            getMarkdownRichModeUnsupportedMessage(inlineMarkdownContent) !== null,
          viewMode: mdViewMode
        })
      : null
  const canExportMarkdownToPdf =
    shouldShowMarkdownExportAction &&
    ((activeFile.mode === 'markdown-preview' &&
      fileContents[activeFile.id] !== undefined &&
      fileContents[activeFile.id]?.isBinary !== true &&
      !fileContents[activeFile.id]?.loadError) ||
      (activeFile.mode === 'edit' &&
        fileContents[activeFile.id] !== undefined &&
        !isChangesMode &&
        inlineMarkdownRenderMode !== null &&
        inlineMarkdownRenderMode !== 'source' &&
        fileContents[activeFile.id]?.isBinary !== true &&
        !fileContents[activeFile.id]?.loadError &&
        activeFile.conflict?.conflictStatus !== 'unresolved'))
  return {
    isSingleDiff,
    isDiffSurface: isSingleDiff || isChangesMode,
    isCombinedDiff,
    worktreeEntries,
    resolvedLanguage,
    openFileState,
    isMarkdown: viewerLanguage === 'markdown',
    isMermaid: viewerLanguage === 'mermaid',
    isCsv: viewerLanguage === 'csv' || viewerLanguage === 'tsv',
    isNotebook: viewerLanguage === 'notebook',
    // Why: the preview renders the on-disk file, so diff surfaces only get it
    // when the modified side still exists on disk (canOpen excludes deleted
    // files and commit diffs whose content may not match the working tree).
    canOpenPreviewToSide:
      canPreviewLanguage(viewerLanguage) &&
      (activeFile.mode === 'edit' || (isSingleDiff && openFileState.canOpen)),
    mdViewMode,
    hasViewModeToggle,
    availableEditorToggleModes,
    hasEditorToggle: availableEditorToggleModes.length > 1,
    effectiveToggleValue,
    isMarkdownTableOfContentsDisabled: hasViewModeToggle && mdViewMode === 'source',
    shouldShowMarkdownExportAction,
    canExportMarkdownToPdf,
    canShowMarkdownTableOfContents:
      viewerLanguage === 'markdown' &&
      (hasViewModeToggle || activeFile.mode === 'markdown-preview'),
    canShowMarkdownPreview: canOpenMarkdownPreview({
      language: viewerLanguage,
      mode: activeFile.mode,
      diffSource: activeFile.diffSource
    })
  }
}
