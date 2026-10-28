import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { readEditorCsvFileContent } from './csv/csv-file-content'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  type FileContent,
  type InFlightContentRead
} from './editor-panel-content-types'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'
import { migrateRestoredEditorFileOwner } from './migrate-restored-editor-file-owner'
import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import { applyEditorFileLoadFailure } from './editor-deleted-file-reload'
import { planEditorFileRead } from './editor-file-read-plan'

const inFlightFileReads = new Map<string, InFlightContentRead<FileContent>>()

export type EditorPanelFileContentLoader = (
  filePath: string,
  id: string,
  worktreeId?: string,
  relativePath?: string,
  options?: EditorPanelContentLoadOptions
) => Promise<void>

type UseEditorPanelFileContentLoaderParams = {
  fileLoadRetryAttemptsRef: MutableRefObject<Record<string, number>>
  fileReadGenerationCounterRef: MutableRefObject<number>
  fileReadGenerationRef: MutableRefObject<Record<string, number>>
  openFilesRef: MutableRefObject<OpenFile[]>
  outstandingFileReadsRef: MutableRefObject<Record<string, number>>
  setFileContents: Dispatch<SetStateAction<Record<string, FileContent>>>
}

function inFlightReadKey(connectionId: string | undefined, filePath: string): string {
  return `${connectionId ?? ''}::${filePath}`
}

export function useEditorPanelFileContentLoader({
  fileLoadRetryAttemptsRef,
  fileReadGenerationCounterRef,
  fileReadGenerationRef,
  openFilesRef,
  outstandingFileReadsRef,
  setFileContents
}: UseEditorPanelFileContentLoaderParams): EditorPanelFileContentLoader {
  return useCallback(
    async (
      filePath: string,
      id: string,
      worktreeId?: string,
      relativePath?: string,
      options?: EditorPanelContentLoadOptions
    ): Promise<void> => {
      const generation = fileReadGenerationCounterRef.current + 1
      fileReadGenerationCounterRef.current = generation
      fileReadGenerationRef.current[id] = generation
      outstandingFileReadsRef.current[id] = generation
      let readConnectionId: string | undefined
      try {
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const trace: { readConnectionId?: string } = {}
        const planned = await planEditorFileRead({
          id,
          filePath,
          worktreeId,
          relativePath,
          tab: restoredOpenFile,
          wakeWslDistro: options?.wakeWslDistro,
          trace
        }).finally(() => {
          readConnectionId = trace.readConnectionId
        })
        if (planned.kind === 'reown') {
          // Re-owning re-keys the tab, which starts a fresh load under the new owner.
          const migration = await migrateRestoredEditorFileOwner(
            id,
            planned.route,
            planned.runtimeEnvironmentId
          )
          if (!migration.ok) {
            throw new Error(
              migration.reason === 'collision'
                ? 'The sibling file is already open; close one tab before restoring it.'
                : 'The sibling file owner changed while the tab was restoring.'
            )
          }
          fileReadGenerationRef.current[id] = ++fileReadGenerationCounterRef.current
          setFileContents((prev) => {
            const next = { ...prev }
            delete next[id]
            return next
          })
          return
        }
        const { readScope, access } = planned
        const allowPagedPreview =
          !restoredOpenFile?.isDirty &&
          (!/\.(csv|tsv)$/i.test(filePath) || useAppStore.getState().editorDrafts[id] === undefined)
        // Keep file authorization and editable drafts isolated between concurrent reads.
        // A background read refused for a stopped distro must not answer a user's waking read.
        const key = `${inFlightReadKey(readScope, filePath)}::${access?.kind ?? ''}${allowPagedPreview ? '' : '::editable'}${options?.wakeWslDistro ? '::wake' : ''}`
        const registeredRead = inFlightFileReads.get(key)
        if (
          options?.force &&
          (options.externalEventGeneration === undefined ||
            registeredRead?.externalEventGeneration !== options.externalEventGeneration)
        ) {
          // Forced reloads must bypass reads started before the external change.
          inFlightFileReads.delete(key)
        }
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          const promise = readEditorCsvFileContent(planned.args, allowPagedPreview)
          pending = {
            externalEventGeneration: options?.externalEventGeneration,
            promise
          }
          inFlightFileReads.set(key, pending)
          queueMicrotask(() => {
            if (inFlightFileReads.get(key) === pending) {
              inFlightFileReads.delete(key)
            }
          })
        }
        const result = await pending.promise
        if (fileReadGenerationRef.current[id] !== generation) {
          return
        }
        if (result.csvPreview && useAppStore.getState().editorDrafts[id] !== undefined) {
          throw new Error(
            'CSV grew too large for editing. Your draft has been kept; reopen the file to preview it.'
          )
        }
        if (result.csvPreview || restoredOpenFile?.csvPreviewOnly) {
          useAppStore.getState().setCsvPreviewOnly(id, Boolean(result.csvPreview))
        }
        delete fileLoadRetryAttemptsRef.current[id]
        setFileContents((prev) => ({ ...prev, [id]: result }))
        stampCleanTabDiskBaseline(id, result)
      } catch (err) {
        if (fileReadGenerationRef.current[id] !== generation) {
          return
        }
        const hostConnection = selectWorktreeHostConnectionPhase(
          useAppStore.getState(),
          worktreeId ?? null
        )
        // Connection failures while SSH connects should wait for readiness instead of appearing as file errors.
        const hostConnecting =
          hostConnection.phase === 'connecting' &&
          readConnectionId !== undefined &&
          readConnectionId === hostConnection.targetId
        const message = hostConnecting
          ? WORKTREE_OWNER_NOT_READY_ERROR
          : err instanceof Error
            ? err.message
            : String(err)
        // Preserve machine error codes separately because hosts may render prose-only messages.
        const loadErrorCode =
          !hostConnecting && err instanceof RuntimeRpcCallError ? err.code : undefined
        const failure: FileContent = {
          content: '',
          isBinary: false,
          loadError: message,
          ...(loadErrorCode ? { loadErrorCode } : {})
        }
        applyEditorFileLoadFailure({
          error: err,
          fileId: id,
          filePath,
          tabs: openFilesRef.current,
          failure,
          setFileContents
        })
      } finally {
        if (outstandingFileReadsRef.current[id] === generation) {
          delete outstandingFileReadsRef.current[id]
        }
      }
    },
    [
      fileLoadRetryAttemptsRef,
      fileReadGenerationCounterRef,
      fileReadGenerationRef,
      openFilesRef,
      outstandingFileReadsRef,
      setFileContents
    ]
  )
}
