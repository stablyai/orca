import React from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import type { OpenFile } from '@/store/slices/editor'
import type { GitDiffResult } from '../../../../shared/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../shared/git-status-types'
import { ConflictBanner } from './ConflictComponents'
import { getDiffContentSignature } from './diff-content-signature'
import { translate } from '@/i18n/i18n'

const DiffViewer = lazy(() => import('./DiffViewer'))

// Render HEAD against the live edit draft so existing dirty tracking, autosave and close prompts keep working without a separate diff tab.
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
  onSave: (content: string) => Promise<boolean>
}): React.JSX.Element {
  if (!dc) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
        {translate('auto.components.editor.ChangesModeView.54e0035b15', 'Loading diff...')}
      </div>
    )
  }
  if (dc.kind === 'binary') {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center">
        <div className="space-y-2">
          <div className="text-sm font-medium text-foreground">
            {translate('auto.components.editor.ChangesModeView.7dffb0f563', 'Binary file')}
          </div>
          <div className="text-xs text-muted-foreground">
            {translate(
              'auto.components.editor.ChangesModeView.052c184f24',
              'Text diff is unavailable for this file.'
            )}
          </div>
        </div>
      </div>
    )
  }
  // Matching sides render blank in Monaco; explain that Changes mode has no changes to show.
  const isDiffBodyPruned = dc.largeDiffRenderLimit?.limited === true
  const isIdentical = !isDiffBodyPruned && dc.originalContent === modifiedContent
  // Rotate only the HEAD model after commit/pull/rebase to refresh Monaco’s retained snapshot while preserving modified-side undo.
  const headContentSignature = getDiffContentSignature(dc.originalContent)
  const originalModelKey = `${diffViewStateKey}:original:${headContentSignature}`
  return (
    <div className="flex flex-1 min-h-0 flex-col">
      {activeFile.conflict && <ConflictBanner file={activeFile} entry={activeConflictEntry} />}
      {isIdentical && (
        <div className="border-b border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {translate(
            'auto.components.editor.ChangesModeView.ef25ae2d09',
            'No uncommitted changes.'
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <DiffViewer
          key={viewStateScopeId}
          modelKey={diffViewStateKey}
          originalModelKey={originalModelKey}
          originalContent={dc.originalContent}
          modifiedContent={modifiedContent}
          largeDiffRenderLimit={dc.largeDiffRenderLimit}
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
