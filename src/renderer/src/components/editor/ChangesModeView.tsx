import React, { lazy } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult, GitStatusEntry } from '../../../../shared/types'
import { ConflictBanner } from './ConflictComponents'
import { getDiffContentSignature } from './diff-content-signature'
import { translate } from '@/i18n/i18n'

const DiffViewer = lazy(() => import('./DiffViewer'))

// Why: Changes view mode renders an edit-mode tab as a HEAD-vs-working-tree
// diff without creating a separate diff-tab object. The draft is the live
// source on the modified side; onContentChange is the same callback as normal
// edit mode so dirty tracking, autosave, and close-prompt plumbing all continue
// to work unchanged. See reviews/changes-view-mode-plan.md.
export function ChangesModeView({
  activeFile,
  dc,
  modifiedContent,
  activeConflictEntry,
  resolvedLanguage,
  sideBySide,
  viewStateScopeId,
  diffViewStateKey,
  onContentChange,
  onSave
}: {
  activeFile: OpenFile
  dc: GitDiffResult | undefined
  modifiedContent: string
  activeConflictEntry: GitStatusEntry | null
  resolvedLanguage: string
  sideBySide: boolean
  viewStateScopeId: string
  diffViewStateKey: string
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<void>
}): React.JSX.Element {
  if (!dc) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {translate("auto.components.editor.ChangesModeView.54e0035b15", "Loading diff...")}</div>
    )
  }
  if (dc.kind === 'binary') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">{translate("auto.components.editor.ChangesModeView.7dffb0f563", "Binary file")}</div>
          <div className="text-xs text-muted-foreground">
            {translate("auto.components.editor.ChangesModeView.052c184f24", "Text diff is unavailable for this file.")}</div>
        </div>
      </div>
    )
  }
  // Why: Monaco renders an empty diff when the two sides match, which reads as
  // a broken view. Surface an inline banner so the user knows Changes mode is
  // active but there is simply nothing to diff right now.
  const isIdentical = dc.originalContent === modifiedContent
  // Why: after a terminal commit/pull/rebase, Changes mode refreshes the
  // HEAD-side blob in React state, but Monaco can keep painting the previous
  // diff if we reuse the same kept model identities. Rotate only the
  // original-side model identity so Monaco rebuilds the stale HEAD snapshot
  // without throwing away the modified-side undo history.
  const headContentSignature = getDiffContentSignature(dc.originalContent)
  const originalModelKey = `${diffViewStateKey}:original:${headContentSignature}`
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {activeFile.conflict && <ConflictBanner file={activeFile} entry={activeConflictEntry} />}
      {isIdentical && (
        <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {translate("auto.components.editor.ChangesModeView.ef25ae2d09", "No uncommitted changes.")}</div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <DiffViewer
          key={viewStateScopeId}
          modelKey={diffViewStateKey}
          originalModelKey={originalModelKey}
          originalContent={dc.originalContent}
          modifiedContent={modifiedContent}
          language={resolvedLanguage}
          filePath={activeFile.filePath}
          relativePath={activeFile.relativePath}
          sideBySide={sideBySide}
          editable={true}
          worktreeId={activeFile.worktreeId}
          onContentChange={onContentChange}
          onSave={onSave}
        />
      </div>
    </div>
  )
}
