import React, { Suspense, useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { editorTabFileAccess } from '@/lib/local-file-access'
import { detectLanguage } from '@/lib/language-detect'
import { readRuntimeFileContent } from '@/runtime/runtime-file-read-client'
import {
  FILE_OWNER_UNRESOLVED_MESSAGE,
  getRuntimeTargetForFileOwner
} from '@/lib/file-owner-runtime-target'
import { useAppStore } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { translate } from '@/i18n/i18n'

const DiffViewer = lazy(() => import('./DiffViewer'))

type DiskReadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'binary' }
  | { kind: 'ready'; content: string }

// Show which content Reload and Keep would discard before either action commits.
export function ExternalFileChangeCompareDialog({
  file,
  currentContent,
  open,
  onOpenChange,
  onReload,
  onKeepEdits
}: {
  file: OpenFile
  /** The tab's live buffer — the unsaved edits the user would keep. */
  currentContent: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onReload: () => void
  onKeepEdits: () => void
}): React.JSX.Element {
  const [diskState, setDiskState] = useState<DiskReadState>({ kind: 'loading' })
  const access = editorTabFileAccess(useAppStore.getState(), file)

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    setDiskState({ kind: 'loading' })
    // Read when opening: agents may have written again since the banner appeared.
    const target = getRuntimeTargetForFileOwner(
      useAppStore.getState(),
      file.worktreeId,
      file.runtimeEnvironmentId
    )
    if (!target) {
      setDiskState({ kind: 'error', message: FILE_OWNER_UNRESOLVED_MESSAGE })
      return
    }
    void readRuntimeFileContent({
      target,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      connectionId: getConnectionIdForFile(file.worktreeId, file.filePath) ?? undefined,
      expectedExternalSshTargetId: file.externalSshTargetId,
      access,
      terminalArtifactGrantId: file.terminalArtifactGrantId
    })
      .then((result) => {
        if (cancelled) {
          return
        }
        setDiskState(
          result.isBinary ? { kind: 'binary' } : { kind: 'ready', content: result.content }
        )
      })
      .catch((err: unknown) => {
        if (cancelled) {
          return
        }
        setDiskState({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err)
        })
      })
    return () => {
      cancelled = true
    }
  }, [
    open,
    file.filePath,
    file.relativePath,
    file.worktreeId,
    file.runtimeEnvironmentId,
    file.externalSshTargetId,
    file.terminalArtifactGrantId,
    access
  ])

  const language = detectLanguage(file.relativePath)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[80vh] w-[90vw] max-w-5xl flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl">
        <DialogHeader className="border-b border-border/60 p-4">
          <DialogTitle>
            {translate(
              'auto.components.editor.ExternalFileChangeCompareDialog.4b8de20a11',
              'File changed on disk'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.editor.ExternalFileChangeCompareDialog.90cc31e4d7',
              'Disk version on the left, your unsaved edits on the right.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1">
          {diskState.kind === 'loading' ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" />
              {translate(
                'auto.components.editor.ExternalFileChangeCompareDialog.8fe30ab254',
                'Reading file from disk...'
              )}
            </div>
          ) : diskState.kind === 'error' ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {translate(
                'auto.components.editor.ExternalFileChangeCompareDialog.e2b1cd0393',
                'Could not read the file from disk: {{value0}}',
                { value0: diskState.message }
              )}
            </div>
          ) : diskState.kind === 'binary' ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {translate(
                'auto.components.editor.ExternalFileChangeCompareDialog.b6cf20d514',
                'The file on disk is binary — no text comparison available.'
              )}
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 size-4 animate-spin" />
                  {translate(
                    'auto.components.editor.ExternalFileChangeCompareDialog.2c8f1e07b9',
                    'Loading comparison...'
                  )}
                </div>
              }
            >
              <div className="flex h-full min-h-0 flex-col">
                <DiffViewer
                  modelKey={`external-change-compare:${file.id}`}
                  originalContent={diskState.content}
                  modifiedContent={currentContent}
                  language={language}
                  filePath={file.filePath}
                  relativePath={file.relativePath}
                  sideBySide
                />
              </div>
            </Suspense>
          )}
        </div>
        <DialogFooter className="border-t border-border/60 p-4">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              onOpenChange(false)
              onReload()
            }}
          >
            {translate(
              'auto.components.editor.ExternalFileChangeCompareDialog.3fa2b8d417',
              'Reload from Disk'
            )}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              onOpenChange(false)
              onKeepEdits()
            }}
          >
            {translate(
              'auto.components.editor.ExternalFileChangeCompareDialog.a95d02c644',
              'Keep My Edits'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
