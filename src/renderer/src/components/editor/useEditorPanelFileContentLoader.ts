import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getDiskBaselineSignature } from './diff-content-signature'
import { getRuntimeFileReadScope, readRuntimeFileContent } from '@/runtime/runtime-file-client'
import { settingsForRuntimeOwner } from '@/runtime/runtime-rpc-client'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import {
  WORKTREE_OWNER_NOT_READY_ERROR,
  type FileContent,
  type InFlightContentRead
} from './editor-panel-content-types'
import type { EditorPanelContentLoadOptions } from './useEditorPanelExternalContentEvents'
import { migrateRestoredEditorFileOwner } from './migrate-restored-editor-file-owner'

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

// Why: a clean load re-baselines what this tab's future edits are based on; a
// dirty tab keeps its baseline (its draft still derives from the older content
// the signature was taken over). Best-effort metadata — a failure here must
// not convert an already-delivered load into an error view, hence the guard.
function stampCleanTabDiskBaseline(id: string, result: FileContent): void {
  if (result.isBinary || result.loadError) {
    return
  }
  try {
    const state = useAppStore.getState()
    const loadedFile = state.openFiles.find((file) => file.id === id)
    if (loadedFile && !loadedFile.isDirty) {
      state.setLastKnownDiskSignature(id, getDiskBaselineSignature(result.content))
    }
  } catch (err) {
    console.warn('[editor] failed to stamp disk baseline', err)
  }
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
      try {
        const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
        const connectionId = resolvedConnectionId ?? undefined
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const activeSettings = useAppStore.getState().settings
        const readSettings = settingsForRuntimeOwner(
          activeSettings,
          restoredOpenFile?.runtimeEnvironmentId
        )
        // Why: liveTail tabs are AI Vault logs discovered on this client, so the
        // worktree's SSH owner must never be inferred for them (a stamp still routes).
        const isLiveTailLogTab =
          restoredOpenFile?.readOnly === true && restoredOpenFile.liveTail === true
        let readConnectionId = connectionId
        let readWorktreeId = worktreeId
        let readRelativePath = restoredOpenFile?.relativePath ?? relativePath
        if (
          resolvedConnectionId === undefined &&
          !readSettings?.activeRuntimeEnvironmentId?.trim() &&
          !isWorktreeConnectionResolved(worktreeId ?? null)
        ) {
          // Why: the backing repo hasn't hydrated yet (SSH still connecting), so
          // we can't tell local from remote. Reading locally would deny a remote
          // path with a terminal "access denied" (#6648); fail retryably instead.
          throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
        }
        if (restoredOpenFile?.filePath === filePath && restoredOpenFile.relativePath === filePath) {
          // Why: an out-of-worktree absolute path in an SSH workspace belongs to the
          // remote host, so the resolved connection owns it even when the tab predates
          // (or was opened outside) the terminal-link path that stamps the target id.
          const externalSshOwnerId =
            restoredOpenFile.externalSshTargetId?.trim() ||
            (isLiveTailLogTab ? undefined : connectionId)
          const runtimeEnvironmentId = isLiveTailLogTab
            ? undefined
            : readSettings?.activeRuntimeEnvironmentId?.trim()
          if (isLiveTailLogTab) {
            await window.api.fs.authorizeExternalPath({ targetPath: filePath })
            readConnectionId = undefined
          } else {
            const currentState = useAppStore.getState()
            const executionHostId = externalSshOwnerId
              ? toSshExecutionHostId(externalSshOwnerId)
              : runtimeEnvironmentId
                ? toRuntimeExecutionHostId(runtimeEnvironmentId)
                : LOCAL_EXECUTION_HOST_ID
            const route = findWorkspaceFileRoute(currentState, executionHostId, filePath)
            if (route && route.worktreeId !== worktreeId) {
              const migration = await migrateRestoredEditorFileOwner(
                id,
                route,
                runtimeEnvironmentId ?? null
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
            if (runtimeEnvironmentId && !route) {
              throw new Error('External local files are not available for remote workspaces.')
            }
            if (!externalSshOwnerId) {
              // Why: client-local external tabs need their main-process path grant
              // refreshed because that authorization is only held in memory.
              await window.api.fs.authorizeExternalPath({ targetPath: filePath })
              // Why: that grant covers the client path, so this read must stay off the
              // worktree's SSH host.
              readConnectionId = undefined
            }
          }
        }
        const readScope = getRuntimeFileReadScope(readSettings, readConnectionId)
        const key = inFlightReadKey(readScope, filePath)
        const registeredRead = inFlightFileReads.get(key)
        if (
          options?.force &&
          (options.externalEventGeneration === undefined ||
            registeredRead?.externalEventGeneration !== options.externalEventGeneration)
        ) {
          // Why: forced reloads must not attach to a currently registered read
          // started before the external change landed.
          inFlightFileReads.delete(key)
        }
        let pending = inFlightFileReads.get(key)
        if (!pending) {
          const promise = readRuntimeFileContent({
            settings: readSettings,
            filePath,
            relativePath: readRelativePath,
            worktreeId: readWorktreeId,
            connectionId: readConnectionId,
            expectedExternalSshTargetId: restoredOpenFile?.externalSshTargetId,
            includeLocalLogMetadata: isLiveTailLogTab
          }) as Promise<FileContent>
          pending = { externalEventGeneration: options?.externalEventGeneration, promise }
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
        delete fileLoadRetryAttemptsRef.current[id]
        setFileContents((prev) => ({ ...prev, [id]: result }))
        stampCleanTabDiskBaseline(id, result)
      } catch (err) {
        if (fileReadGenerationRef.current[id] !== generation) {
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setFileContents((prev) => ({
          ...prev,
          [id]: { content: '', isBinary: false, loadError: message }
        }))
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
