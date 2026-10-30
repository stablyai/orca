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
import { getMarkdownRenderMode, type MarkdownRenderState } from './markdown-render-mode'
import { getCachedMarkdownRichModeEligibility } from './markdown-rich-mode-eligibility-cache'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'
import {
  customEditorToggleValue,
  resolveCustomEditorToggle,
  type CustomEditorToggle
} from './custom-editor-toggle'
import type {
  ActivePluginCustomEditor,
  CustomEditorViewChoice
} from '@/store/plugin-custom-editors'

type StoreState = ReturnType<typeof useAppStore.getState>

type EditorPanelRenderModelParams = {
  activeFile: OpenFile
  fileContents: Record<string, FileContent>
  editorDrafts: StoreState['editorDrafts']
  gitStatusEntries: StoreState['gitStatusByWorktree'][string] | undefined
  gitBranchEntries: StoreState['gitBranchChangesByWorktree'][string] | undefined
  markdownViewMode: StoreState['markdownViewMode']
  markdownRichModeSizeOverridden: boolean
  isChangesMode: boolean
  canOpenWorkspaceFileBrowser: boolean
  /** Enabled plugins' editors for this file, in priority order. */
  customEditors?: readonly ActivePluginCustomEditor[]
  customEditorChoice?: CustomEditorViewChoice
}

export function getEditorPanelRenderModel({
  activeFile,
  fileContents,
  editorDrafts,
  gitStatusEntries,
  gitBranchEntries,
  markdownViewMode,
  markdownRichModeSizeOverridden,
  isChangesMode,
  canOpenWorkspaceFileBrowser,
  customEditors = [],
  customEditorChoice
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
  // Why: diff drafts vanish on save, so shebang detection there would flicker; diffs stay name-based.
  const resolvedLanguage =
    activeFile.mode === 'diff'
      ? detectLanguage(activeFile.relativePath)
      : detectLanguage(
          activeFile.filePath,
          editorDrafts[activeFile.id] ?? fileContents[activeFile.id]?.content
        )
  // Read-only artifact tabs require raw source viewers; retain real-language tokenization while suppressing rich/preview modes and their editing affordances.
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
  const inlineFileContent = activeFile.mode === 'edit' ? fileContents[activeFile.id] : undefined
  const customEditorContentReady =
    activeFile.mode === 'edit' &&
    inlineFileContent !== undefined &&
    !inlineFileContent.loadError &&
    inlineFileContent.csvPreview === undefined &&
    activeFile.conflict === undefined
  // Read-only tabs keep raw source, as for every other rich view.
  const textEditorEligible =
    customEditorContentReady && !rawReadOnly && inlineFileContent?.isBinary !== true
  // Bytes editors honor read-only themselves, so they open read-only tabs too; they need a pageable route.
  const bytesEditorEligible =
    customEditorContentReady && inlineFileContent?.byteSource !== undefined
  const eligibleCustomEditors = customEditors.filter((editor) =>
    editor.contentKind === 'bytes' ? bytesEditorEligible : textEditorEligible
  )
  const customEditorToggle: CustomEditorToggle | null = resolveCustomEditorToggle({
    editors: eligibleCustomEditors,
    choice: customEditorChoice,
    eligible: eligibleCustomEditors.length > 0,
    sourceModes: availableEditorToggleModes
  })
  const activeCustomEditor = isChangesMode ? null : (customEditorToggle?.active ?? null)
  const effectiveToggleValue: EditorToggleValue = isChangesMode
    ? 'changes'
    : activeCustomEditor
      ? customEditorToggleValue(activeCustomEditor)
      : hasViewModeToggle
        ? mdViewMode
        : 'edit'
  const toggleModes = customEditorToggle?.modes ?? availableEditorToggleModes
  const inlineMarkdownContent =
    activeFile.mode === 'edit'
      ? (editorDrafts[activeFile.id] ?? fileContents[activeFile.id]?.content ?? null)
      : null
  const shouldShowMarkdownExportAction =
    viewerLanguage === 'markdown' &&
    (activeFile.mode === 'edit' || activeFile.mode === 'markdown-preview')
  const canRenderInlineMarkdown =
    viewerLanguage === 'markdown' &&
    activeFile.mode === 'edit' &&
    inlineMarkdownContent !== null &&
    !isChangesMode &&
    inlineFileContent !== undefined &&
    inlineFileContent.isBinary !== true &&
    !inlineFileContent.loadError &&
    activeFile.conflict?.kind !== 'conflict-placeholder' &&
    activeFile.conflict?.conflictStatus !== 'unresolved'
  let inlineMarkdownRenderState: MarkdownRenderState | null = null
  if (canRenderInlineMarkdown) {
    const shouldClassifyRichMode = mdViewMode === 'rich'
    const richModeEligibility = shouldClassifyRichMode
      ? getCachedMarkdownRichModeEligibility({
          content: inlineMarkdownContent,
          sizeOverridden: markdownRichModeSizeOverridden
        })
      : null
    const richModeUnsupportedMessage = richModeEligibility?.unsupportedMessage ?? null
    inlineMarkdownRenderState = {
      renderMode: getMarkdownRenderMode({
        exceedsRichModeSizeLimit: richModeEligibility?.exceedsSizeLimit ?? false,
        hasRichModeUnsupportedContent: richModeUnsupportedMessage !== null,
        viewMode: mdViewMode
      }),
      richModeUnsupportedMessage
    }
  }
  const canExportMarkdownToPdf =
    shouldShowMarkdownExportAction &&
    ((activeFile.mode === 'markdown-preview' &&
      fileContents[activeFile.id] !== undefined &&
      fileContents[activeFile.id]?.isBinary !== true &&
      !fileContents[activeFile.id]?.loadError &&
      !exceedsMarkdownRichModeSizeLimit(
        editorDrafts[activeFile.markdownPreviewSourceFileId ?? activeFile.filePath] ??
          fileContents[activeFile.id].content
      )) ||
      (activeFile.mode === 'edit' &&
        fileContents[activeFile.id] !== undefined &&
        !isChangesMode &&
        inlineMarkdownRenderState !== null &&
        inlineMarkdownRenderState.renderMode !== 'source' &&
        (inlineMarkdownRenderState.renderMode !== 'preview' ||
          !exceedsMarkdownRichModeSizeLimit(
            editorDrafts[activeFile.id] ?? fileContents[activeFile.id].content
          )) &&
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
    // Preview reads disk; exclude deleted modified sides and historical commit snapshots that may not match it.
    canOpenPreviewToSide:
      canOpenWorkspaceFileBrowser &&
      canPreviewLanguage(viewerLanguage) &&
      (activeFile.mode === 'edit' || (isSingleDiff && openFileState.canOpen)),
    mdViewMode,
    hasViewModeToggle,
    availableEditorToggleModes: toggleModes,
    hasEditorToggle: toggleModes.length > 1,
    effectiveToggleValue,
    customEditors: customEditorToggle?.editors ?? [],
    customEditorTitles: Object.fromEntries(
      (customEditorToggle?.editors ?? []).map((editor) => [
        customEditorToggleValue(editor),
        editor.title
      ])
    ),
    activeCustomEditor,
    isMarkdownTableOfContentsDisabled: hasViewModeToggle && mdViewMode === 'source',
    shouldShowMarkdownExportAction,
    canExportMarkdownToPdf,
    inlineMarkdownRenderState,
    canShowMarkdownTableOfContents:
      viewerLanguage === 'markdown' &&
      activeCustomEditor === null &&
      (hasViewModeToggle || activeFile.mode === 'markdown-preview'),
    canShowMarkdownPreview: canOpenMarkdownPreview({
      language: viewerLanguage,
      mode: activeFile.mode,
      diffSource: activeFile.diffSource
    })
  }
}
