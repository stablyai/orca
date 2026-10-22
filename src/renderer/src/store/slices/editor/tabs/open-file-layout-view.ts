// An editor tab's open file as main's layout holds its view, and back: a window that lacks a diff,
// conflict, preview or check-details tab's open file rebuilds it from the view a frame publishes.

import type { EditorTabView } from '../../../../../../shared/editor-tab-view-types'
import type { LayoutEditorView } from '../../../../../../shared/workspace-layout/layout-editor-view'
import { pickStoredFields } from '../../../../../../shared/workspace-layout/stored-record-fields'
import type { OpenFile } from '../types/open-file'

const DIFF_VIEW_FIELDS = [
  'diffSource',
  'branchCompare',
  'commitCompare',
  'branchOldPath',
  'combinedAlternate',
  'combinedAreaFilter',
  'branchEntriesSnapshot',
  'commitEntriesSnapshot',
  'uncommittedEntriesSnapshot',
  'skippedConflicts'
] as const satisfies readonly (keyof OpenFile)[]

function editorTabViewOf(file: OpenFile): EditorTabView | null {
  switch (file.mode) {
    case 'edit':
      return file.conflict ? { mode: 'edit', conflict: file.conflict } : null
    case 'diff':
      return { mode: 'diff', ...pickStoredFields(file, DIFF_VIEW_FIELDS) }
    case 'markdown-preview':
      return {
        mode: 'markdown-preview',
        ...pickStoredFields(file, ['markdownPreviewSourceFileId', 'markdownPreviewAnchor'])
      }
    case 'conflict-review':
      return { mode: 'conflict-review', ...pickStoredFields(file, ['conflictReview']) }
    case 'check-details':
      return { mode: 'check-details', ...pickStoredFields(file, ['checkRunDetails']) }
  }
}

/** Null for a plain edit-mode file: its saved file record already rebuilds it. */
export function layoutEditorViewOfOpenFile(file: OpenFile): LayoutEditorView | null {
  const view = editorTabViewOf(file)
  if (!view) {
    return null
  }
  return {
    view,
    file: {
      filePath: file.filePath,
      relativePath: file.relativePath,
      language: file.language,
      ...pickStoredFields(file, ['runtimeEnvironmentId', 'externalSshTargetId', 'readOnly'])
    }
  }
}

/** The open file a tab showing `editorView` draws; clean, with none of a window's live state. */
export function openFileOfLayoutEditorView(
  editorView: LayoutEditorView,
  tab: { entityId: string; worktreeId: string; isPreview?: boolean }
): OpenFile {
  return {
    id: tab.entityId,
    worktreeId: tab.worktreeId,
    ...editorView.file,
    isDirty: false,
    ...(tab.isPreview ? { isPreview: true } : {}),
    ...editorView.view
  }
}
