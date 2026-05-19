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

type StoreState = ReturnType<typeof useAppStore.getState>

type EditorPanelRenderModelParams = {
  activeFile: OpenFile
  fileContents: Record<string, FileContent>
  gitStatusByWorktree: StoreState['gitStatusByWorktree']
  gitBranchChangesByWorktree: StoreState['gitBranchChangesByWorktree']
  markdownViewMode: StoreState['markdownViewMode']
  isChangesMode: boolean
}

export function getEditorPanelRenderModel({
  activeFile,
  fileContents,
  gitStatusByWorktree,
  gitBranchChangesByWorktree,
  markdownViewMode,
  isChangesMode
}: EditorPanelRenderModelParams) {
  const isSingleDiff =
    activeFile.mode === 'diff' &&
    activeFile.diffSource !== undefined &&
    activeFile.diffSource !== 'combined-uncommitted' &&
    activeFile.diffSource !== 'combined-branch' &&
    activeFile.diffSource !== 'combined-commit'
  const isCombinedDiff =
    activeFile.mode === 'diff' &&
    (activeFile.diffSource === 'combined-uncommitted' ||
      activeFile.diffSource === 'combined-branch' ||
      activeFile.diffSource === 'combined-commit')
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(activeFile.filePath)
  const worktreeEntries = gitStatusByWorktree[activeFile.worktreeId] ?? []
  const branchEntries = gitBranchChangesByWorktree[activeFile.worktreeId] ?? []
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
  const markdownViewModes = getMarkdownViewModes({
    language: resolvedLanguage,
    mode: activeFile.mode,
    diffSource: activeFile.diffSource
  })
  const hasViewModeToggle = markdownViewModes.length > 0
  const defaultMarkdownViewMode = getDefaultMarkdownViewMode({
    language: resolvedLanguage,
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
    language: resolvedLanguage,
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
  return {
    isSingleDiff,
    isDiffSurface: isSingleDiff || isChangesMode,
    isCombinedDiff,
    worktreeEntries,
    resolvedLanguage,
    openFileState: getEditorHeaderOpenFileState(
      activeFile,
      matchingWorktreeEntry,
      matchingBranchEntry
    ),
    isMarkdown: resolvedLanguage === 'markdown',
    isMermaid: resolvedLanguage === 'mermaid',
    isCsv: resolvedLanguage === 'csv' || resolvedLanguage === 'tsv',
    isNotebook: resolvedLanguage === 'notebook',
    canOpenPreviewToSide: activeFile.mode === 'edit' && canPreviewLanguage(resolvedLanguage),
    mdViewMode,
    hasViewModeToggle,
    availableEditorToggleModes,
    hasEditorToggle: availableEditorToggleModes.length > 1,
    effectiveToggleValue,
    isMarkdownTableOfContentsDisabled: hasViewModeToggle && mdViewMode === 'source',
    canShowMarkdownTableOfContents:
      resolvedLanguage === 'markdown' &&
      (hasViewModeToggle || activeFile.mode === 'markdown-preview'),
    canShowMarkdownPreview: canOpenMarkdownPreview({
      language: resolvedLanguage,
      mode: activeFile.mode,
      diffSource: activeFile.diffSource
    })
  }
}
