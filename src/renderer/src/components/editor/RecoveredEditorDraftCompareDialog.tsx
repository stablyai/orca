import React, { Suspense, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { detectLanguage } from '@/lib/language-detect'
import { getRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { recoveredEditorDraftId } from '@/store/slices/editor/buffers/recovered-editor-drafts'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { RecoveredEditorDraft } from '../../../../shared/workspace-session-state-types'

const DiffViewer = lazy(() => import('./DiffViewer'))

/** The file's text now: an open tab's unsaved draft, else the disk text. */
async function readCurrentText(draft: RecoveredEditorDraft): Promise<string> {
  const state = useAppStore.getState()
  const open = state.openFiles.find(
    (file) => file.filePath === draft.filePath && file.worktreeId === draft.worktreeId
  )
  const openDraft = open ? state.editorDrafts[open.id] : undefined
  if (openDraft !== undefined) {
    return openDraft
  }
  const target = getRuntimeTargetForFileOwner(
    state,
    draft.worktreeId,
    draft.runtimeEnvironmentId ?? undefined
  )
  if (!target) {
    throw new Error('The file owner is not available.')
  }
  const result = await readRuntimeFileContent({
    target,
    filePath: draft.filePath,
    relativePath: draft.relativePath,
    worktreeId: draft.worktreeId,
    // Why: an SSH file must be read on its host, the same way the editor's own load reads it.
    connectionId: getConnectionIdForFile(draft.worktreeId, draft.filePath) ?? undefined
  })
  return result.isBinary ? '' : result.content
}

/** Recovered draft on the left, the file as it is now on the right. */
export function RecoveredEditorDraftCompareDialog({
  draft,
  onOpenChange
}: {
  draft: RecoveredEditorDraft | null
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const [current, setCurrent] = useState<{ text: string } | { error: string } | null>(null)

  useEffect(() => {
    if (!draft) {
      return
    }
    let cancelled = false
    setCurrent(null)
    void readCurrentText(draft)
      .then((text) => !cancelled && setCurrent({ text }))
      .catch((err: unknown) => !cancelled && setCurrent({ error: String(err) }))
    return () => {
      cancelled = true
    }
  }, [draft])

  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[90vw] max-w-5xl flex-col overflow-hidden sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.editor.RecoveredEditorDraftCompareDialog.6f1d2c9a40',
              'Recovered draft'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.editor.RecoveredEditorDraftCompareDialog.a83e57b1c2',
              'The recovered draft on the left, the file as it is now on the right.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {!draft || current === null ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
            </div>
          ) : 'error' in current ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {current.error}
            </div>
          ) : (
            <Suspense fallback={null}>
              <div className="flex h-full min-h-0 flex-col">
                <DiffViewer
                  modelKey={`recovered-draft-compare:${recoveredEditorDraftId(draft)}`}
                  originalContent={draft.draft}
                  modifiedContent={current.text}
                  language={detectLanguage(draft.relativePath ?? draft.filePath)}
                  filePath={draft.filePath}
                  relativePath={draft.relativePath ?? draft.filePath}
                  sideBySide
                />
              </div>
            </Suspense>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
