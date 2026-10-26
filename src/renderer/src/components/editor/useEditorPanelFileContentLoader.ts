import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile, isWorktreeConnectionResolved } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { getRuntimeFileReadScope } from '@/runtime/runtime-file-routing'
import { readEditorCsvFileContent } from './csv/csv-file-content'
import { RuntimeRpcCallError } from '@/runtime/runtime-rpc-result'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { requireRuntimeTargetForFileOwner } from '@/lib/file-owner-runtime-target'
import { findWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
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
import { findRestoredEditorWorkspaceRuntimeOwner } from './restored-editor-workspace-runtime-owner'
import type { RuntimeWorkspaceFileRoute } from '@/lib/runtime-workspace-file-route'
import { editorTabFileAccess, isClientLocalReadOnlyTab } from '@/lib/local-file-access'
import { isFloatingWorkspaceId } from '../../../../shared/floating-workspace-worktree'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'
import { stampCleanTabDiskBaseline } from './editor-clean-tab-disk-baseline'
import { applyEditorFileLoadFailure } from './editor-deleted-file-reload'

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
        const resolvedConnectionId = getConnectionIdForFile(worktreeId ?? null, filePath)
        const connectionId = resolvedConnectionId ?? undefined
        const restoredOpenFile = openFilesRef.current.find((file) => file.id === id)
        const isLiveTailLogTab =
          restoredOpenFile?.readOnly === true && restoredOpenFile.liveTail === true
        // Client-local tabs must not inherit workspace SSH/runtime ownership; explicit stamps still route.
        const isClientLocalTab = restoredOpenFile
          ? isClientLocalReadOnlyTab(restoredOpenFile)
          : false
        const readTarget: RuntimeClientTarget =
          isClientLocalTab && restoredOpenFile?.runtimeEnvironmentId === undefined
            ? { kind: 'local' }
            : requireRuntimeTargetForFileOwner(
                useAppStore.getState(),
                worktreeId,
                restoredOpenFile?.runtimeEnvironmentId
              )
        const readOwnerEnvironmentId =
          readTarget.kind === 'environment' ? readTarget.environmentId : undefined
        readConnectionId = connectionId
        let readWorktreeId = worktreeId
        let readRelativePath = restoredOpenFile?.relativePath ?? relativePath
        // Re-owning re-keys the tab, which starts a fresh load under the new owner.
        const reownRestoredFile = async (
          route: RuntimeWorkspaceFileRoute,
          runtimeEnvironmentId: string | null
        ): Promise<void> => {
          const migration = await migrateRestoredEditorFileOwner(id, route, runtimeEnvironmentId)
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
        }
        const workspaceRuntimeOwner =
          restoredOpenFile && !isClientLocalTab
            ? findRestoredEditorWorkspaceRuntimeOwner(
                useAppStore.getState(),
                restoredOpenFile,
                worktreeId
              )
            : null
        if (workspaceRuntimeOwner) {
          await reownRestoredFile(
            workspaceRuntimeOwner.route,
            workspaceRuntimeOwner.runtimeEnvironmentId
          )
          return
        }
        if (
          !isClientLocalTab &&
          resolvedConnectionId === undefined &&
          !readOwnerEnvironmentId &&
          !isWorktreeConnectionResolved(worktreeId ?? null)
        ) {
          // Unhydrated owners may be remote; fail retryably rather than turning a bad client-local read into terminal access denial.
          throw new Error(WORKTREE_OWNER_NOT_READY_ERROR)
        }
        if (restoredOpenFile?.filePath === filePath && restoredOpenFile.relativePath === filePath) {
          // Absolute paths in SSH workspaces belong to their resolved host, including legacy tabs without terminal-link stamps.
          const externalSshOwnerId =
            restoredOpenFile.externalSshTargetId?.trim() ||
            (isClientLocalTab ? undefined : connectionId)
          const runtimeEnvironmentId = isClientLocalTab ? undefined : readOwnerEnvironmentId
          if (isClientLocalTab) {
            readConnectionId = undefined
          } else {
            const currentState = useAppStore.getState()
            const executionHostId = externalSshOwnerId
              ? toSshExecutionHostId(externalSshOwnerId)
              : runtimeEnvironmentId
                ? toRuntimeExecutionHostId(runtimeEnvironmentId)
                : LOCAL_EXECUTION_HOST_ID
            // Floating files stay in their panel even when a project also contains the path.
            const route = isFloatingWorkspaceId(worktreeId)
              ? null
              : findWorkspaceFileRoute(currentState, executionHostId, filePath)
            if (route && route.worktreeId !== worktreeId) {
              await reownRestoredFile(route, runtimeEnvironmentId ?? null)
              return
            }
            if (
              runtimeEnvironmentId &&
              !route &&
              !restoredOpenFile.terminalArtifactGrantId &&
              !chatScratchFileAddress(filePath)
            ) {
              throw new Error('External local files are not available for remote workspaces.')
            }
            if (!externalSshOwnerId) {
              // Client-local external tabs must stay off the workspace’s SSH host.
              readConnectionId = undefined
            }
          }
        }
        const readScope = getRuntimeFileReadScope(readTarget, readConnectionId)
        const access = restoredOpenFile
          ? editorTabFileAccess(useAppStore.getState(), restoredOpenFile)
          : undefined
        const allowPagedPreview =
          !restoredOpenFile?.isDirty &&
          (!/\.(csv|tsv)$/i.test(filePath) || useAppStore.getState().editorDrafts[id] === undefined)
        // Keep file authorization and editable drafts isolated between concurrent reads.
        const key = `${inFlightReadKey(readScope, filePath)}::${access?.kind ?? ''}${allowPagedPreview ? '' : '::editable'}`
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
          const promise = readEditorCsvFileContent(
            {
              target: readTarget,
              filePath,
              relativePath: readRelativePath,
              worktreeId: readWorktreeId,
              connectionId: readConnectionId,
              expectedExternalSshTargetId: restoredOpenFile?.externalSshTargetId,
              includeLocalLogMetadata: isLiveTailLogTab,
              access,
              terminalArtifactGrantId: restoredOpenFile?.terminalArtifactGrantId,
              pageOversizedBinary: true
            },
            allowPagedPreview
          )
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
