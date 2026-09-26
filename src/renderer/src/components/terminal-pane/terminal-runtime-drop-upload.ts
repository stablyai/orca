import { createElement } from 'react'
import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import {
  endRuntimeUploadSession,
  settleRuntimeUploadSession,
  startRuntimeUploadSession,
  updateRuntimeUploadRow
} from '@/runtime/runtime-upload-session-state'
import type { useAppStore } from '@/store'
import { TerminalDropUploadToast } from './TerminalDropUploadToast'
import type { NativeDropFlowArgs } from './terminal-drop-paste'
import { pasteResolvedDropPaths } from './terminal-drop-paste'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import {
  getTerminalTargetShellForWorktreePath,
  isTerminalDropWindowsPathLike
} from './terminal-drop-shell'
import { joinRuntimeTerminalDropDir } from './terminal-drop-worktree-path'

export async function uploadRuntimeDropPaths(
  args: NativeDropFlowArgs & {
    runtimeEnvironmentId: string
    settings: ReturnType<typeof useAppStore.getState>['settings']
    worktreeId: string
  }
): Promise<void> {
  const targetShell = getTerminalTargetShellForWorktreePath(args.worktreePath)
  const destinationDir = joinRuntimeTerminalDropDir(args.worktreePath)
  const sessionId = createBrowserUuid()
  const cancelledSourcePaths = new Set<string>()
  const sourcePathsByUploadId = new Map<string, string>()
  let pending: string | number | null = null
  const cancelRow = (uploadId: string): void => {
    const sourcePath = sourcePathsByUploadId.get(uploadId)
    if (sourcePath) {
      cancelledSourcePaths.add(sourcePath)
    }
    updateRuntimeUploadRow(sessionId, uploadId, { status: 'cancelled' })
    void window.api.fs.cancelRuntimeUpload({ uploadId })
  }
  try {
    const { results } = await importExternalPathsToRuntime(
      {
        // Why: drops into existing worktrees must follow the worktree owner,
        // not the currently focused host in the sidebar.
        settings: { ...args.settings, activeRuntimeEnvironmentId: args.runtimeEnvironmentId },
        worktreeId: args.worktreeId,
        worktreePath: args.worktreePath,
        expectedExecutionHostId: args.expectedExecutionHostId,
        expectedSshTargetId: args.expectedSshTargetId,
        expectedSshConnectionGeneration: args.expectedSshConnectionGeneration
      },
      args.dataPaths,
      destinationDir,
      {
        assertCurrent: args.assertCurrent,
        progress: {
          onStart: (rows) => {
            // A drop where every source was skipped still reports a start.
            if (rows.length === 0) {
              return
            }
            for (const row of rows) {
              sourcePathsByUploadId.set(row.uploadId, row.sourcePath)
            }
            startRuntimeUploadSession(
              sessionId,
              rows.map((row) => ({
                uploadId: row.uploadId,
                name: row.name,
                sentBytes: 0,
                totalBytes: row.totalBytes,
                status: 'uploading' as const
              }))
            )
            // Why: created only once rows exist, so a drop that stages nothing
            // never flashes an empty panel.
            // Why: createElement, not a direct call — the toast body must be its
            // own component or its hooks run outside a component boundary.
            const renderPanel = (toastId: string | number) =>
              createElement(TerminalDropUploadToast, {
                sessionId,
                onCancel: cancelRow,
                onDismiss: () => {
                  toast.dismiss(toastId)
                  endRuntimeUploadSession(sessionId)
                },
                onLayoutChange: () => showPanel()
              })
            const panelOptions = { duration: Infinity, dismissible: false, unstyled: true }
            const showPanel = (): void => {
              // Why: the id key is omitted, not set to undefined. sonner spreads these
              // options over the id it just minted, so an explicit `id: undefined`
              // makes it register the toast under a different id than it returns —
              // and the next re-issue then adds a second panel instead of updating.
              pending =
                pending === null
                  ? toast.custom(renderPanel, panelOptions)
                  : toast.custom(renderPanel, { ...panelOptions, id: pending })
            }
            showPanel()
          },
          onRowProgress: (uploadId, sentBytes) =>
            updateRuntimeUploadRow(sessionId, uploadId, { sentBytes }),
          onRowSettled: (uploadId, status) =>
            updateRuntimeUploadRow(sessionId, uploadId, { status }),
          onFinish: () => settleRuntimeUploadSession(sessionId)
        }
      }
    )
    const imported = results.filter((result) => result.status === 'imported')
    const importedPaths = imported.map((result) =>
      isTerminalDropWindowsPathLike(args.worktreePath)
        ? result.destPath.replace(/\//g, '\\')
        : result.destPath
    )
    await pasteResolvedDropPaths({ ...args, paths: importedPaths, targetShell })
    reportTerminalDropUploadSkipsAndFailures(
      results.filter((result) => result.status === 'skipped'),
      // Why: a cancel is the user's own decision, not a failure to report back.
      results
        .filter((result) => result.status === 'failed')
        .filter((result) => !cancelledSourcePaths.has(result.sourcePath))
    )
  } catch (err) {
    // Why: only the error path tears the panel down immediately. On success it
    // owns its own exit, holding long enough to show how the drop ended.
    endRuntimeUploadSession(sessionId)
    if (pending !== null) {
      toast.dismiss(pending)
    }
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
  }
}
