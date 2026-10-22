// Editor, diff and markdown-preview tabs as today's `session.tabs.*` rows, built from the model's
// file records and the in-memory views the window publishes. Each row matches the window's
// (buildMobileMarkdownTab / buildMobileFileTab), with its open-file id as `sourceFileId`.

import type {
  RuntimeMobileSessionFileTab,
  RuntimeMobileSessionMarkdownTab
} from '../../runtime-mobile-session-tab-contracts'
import type { LayoutEditorView } from '../layout-editor-view'
import type { DesktopLayoutView } from '../workspace-layout-beside'
import { editorFileKey, editorTabFile } from '../workspace-layout-editor-tab-file'
import type { LayoutContentTab, LayoutEditorFile, WorkspaceLayout } from '../workspace-layout-model'

export type EditorRowScope = {
  key: string
  workspace: WorkspaceLayout
  view: Pick<DesktopLayoutView, 'editorDrafts'>
  activeTabId: string | null
}

type EditorRow = RuntimeMobileSessionMarkdownTab | RuntimeMobileSessionFileTab

const fileName = (relativePath: string, fallback: string): string =>
  relativePath.split(/[\\/]/).pop() || relativePath || fallback

const tabRowProps = (tab: LayoutContentTab, scope: EditorRowScope) => ({
  color: tab.color ?? null,
  isPinned: tab.isPinned === true,
  isActive: scope.activeTabId === tab.id
})

function hasDraft(
  scope: EditorRowScope,
  file: Pick<LayoutEditorFile, 'filePath' | 'runtimeEnvironmentId'>
): boolean {
  return scope.view.editorDrafts[scope.key]?.[editorFileKey(file)]?.dirtyDraftContent !== undefined
}

/** An editor tab's row: a markdown preview from its view, else the file record it shows. */
export function editorTabRow(tab: LayoutContentTab, scope: EditorRowScope): EditorRow | null {
  const editorView = scope.workspace.editorViews?.[tab.id]
  if (editorView?.view.mode === 'markdown-preview') {
    return markdownPreviewRow(
      tab,
      editorView.file,
      editorView.view.markdownPreviewSourceFileId,
      scope
    )
  }
  const file = editorTabFile(scope.workspace, tab.entityId)
  if (!file) {
    return null
  }
  const common = {
    id: tab.id,
    filePath: file.filePath,
    relativePath: file.relativePath,
    isDirty: hasDraft(scope, file),
    ...tabRowProps(tab, scope)
  }
  if (file.language === 'markdown') {
    return {
      ...common,
      type: 'markdown',
      title: fileName(file.relativePath, 'Markdown'),
      language: 'markdown',
      mode: 'edit',
      // The window's open-file id (a path or an owned id), which the tab's entity id is.
      sourceFileId: tab.entityId,
      sourceFilePath: file.filePath,
      sourceRelativePath: file.relativePath,
      documentVersion: `file:${tab.entityId}`
    }
  }
  return {
    ...common,
    type: 'file',
    title: fileName(file.relativePath, 'File'),
    language: file.language,
    mode: 'edit'
  }
}

/** The source is the open edit tab the preview names; with that tab closed, the preview itself. */
function markdownPreviewRow(
  tab: LayoutContentTab,
  preview: LayoutEditorView['file'],
  sourceFileId: string | undefined,
  scope: EditorRowScope
): RuntimeMobileSessionMarkdownTab {
  const sourceShown =
    sourceFileId !== undefined &&
    scope.workspace.tabs.some((other) => other.kind === 'editor' && other.entityId === sourceFileId)
  const source = sourceShown ? editorTabFile(scope.workspace, sourceFileId) : undefined
  const sourceId = source && sourceFileId ? sourceFileId : tab.entityId
  const sourceFile = source ?? preview
  return {
    type: 'markdown',
    id: tab.id,
    title: fileName(preview.relativePath, 'Markdown'),
    filePath: preview.filePath,
    relativePath: preview.relativePath,
    language: 'markdown',
    mode: 'markdown-preview',
    // A preview holds no draft of its own; its source's draft makes it dirty.
    isDirty: source ? hasDraft(scope, source) : false,
    sourceFileId: sourceId,
    sourceFilePath: sourceFile.filePath,
    sourceRelativePath: sourceFile.relativePath,
    documentVersion: `file:${sourceId}`,
    ...tabRowProps(tab, scope)
  }
}

/** A diff tab's row from its view; a combined diff (display labels as paths) is not listed. */
export function diffTabRow(
  tab: LayoutContentTab,
  scope: EditorRowScope
): RuntimeMobileSessionFileTab | null {
  const editorView = scope.workspace.editorViews?.[tab.id]
  if (editorView?.view.mode !== 'diff') {
    return null
  }
  const { diffSource } = editorView.view
  if (diffSource?.startsWith('combined-')) {
    return null
  }
  const { file } = editorView
  return {
    type: 'file',
    id: tab.id,
    title: fileName(file.relativePath, 'File'),
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    mode: 'diff',
    ...(diffSource === 'staged' || diffSource === 'unstaged' ? { diffSource } : {}),
    // The model holds no unsaved edit of a diff's modified side; the window's row it lists wins.
    isDirty: false,
    ...tabRowProps(tab, scope)
  }
}

/**
 * A conflict-review or check-details tab's row from its view: a plain file row, as the window lists
 * it (buildMobileFileTab), so an older client keeps seeing the tab once the window's rows are gone.
 */
export function reviewTabRow(
  tab: LayoutContentTab & { kind: 'conflict-review' | 'check-details' },
  scope: EditorRowScope
): RuntimeMobileSessionFileTab | null {
  const editorView = scope.workspace.editorViews?.[tab.id]
  if (editorView?.view.mode !== tab.kind) {
    return null
  }
  const { file } = editorView
  return {
    type: 'file',
    id: tab.id,
    title: fileName(file.relativePath, 'File'),
    filePath: file.filePath,
    relativePath: file.relativePath,
    language: file.language,
    mode: 'edit',
    // The model holds no unsaved edit of a review; the window's row it lists wins.
    isDirty: false,
    ...tabRowProps(tab, scope)
  }
}
