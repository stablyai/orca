import { createElement } from 'react'
import { toast } from 'sonner'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { openWorktreeScopedToast, type WorktreeScopedToast } from '@/lib/worktree-scoped-toast'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import {
  endRuntimeUploadSession,
  getRuntimeUploadSession,
  settleRuntimeUploadSession,
  startRuntimeUploadSession,
  updateRuntimeUploadRow
} from '@/runtime/runtime-upload-session-state'
import type { useAppStore } from '@/store'
import { TerminalDropUploadToast } from './TerminalDropUploadToast'
import type { NativeDropFlowArgs } from './terminal-drop-paste'
import { pasteResolvedDropPaths } from './terminal-drop-paste'
import { describeDropWorkspaceIfInactive } from './terminal-drop-workspace-label'
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
  const cancelledUploadIds = new Set<string>()
  let panel: WorktreeScopedToast | null = null
  const closePanel = (): void => {
    panel?.close()
    endRuntimeUploadSession(sessionId)
  }
  const cancelRow = (uploadId: string): void => {
    cancelledUploadIds.add(uploadId)
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
            const renderPanel = () =>
              createElement(TerminalDropUploadToast, {
                sessionId,
                onCancel: cancelRow,
                onDismiss: closePanel,
                onLayoutChange: () => panel?.refresh()
              })
            const panelOptions = { duration: Infinity, dismissible: false, unstyled: true }
            // Why: the upload belongs to the workspace it was dropped into, so its
            // panel shows only there instead of stacking over every workspace.
            panel = openWorktreeScopedToast({
              worktreeId: args.worktreeId,
              // Why: the id key is omitted, not set to undefined. sonner spreads these
              // options over the id it just minted, so an explicit `id: undefined`
              // makes it register the toast under a different id than it returns —
              // and the next re-issue then adds a second panel instead of updating.
              show: (id) =>
                id === undefined
                  ? toast.custom(renderPanel, panelOptions)
                  : toast.custom(renderPanel, { ...panelOptions, id }),
              // Why: hiding unmounts the panel's outcome timer, so a settled drop
              // would otherwise never end.
              onHidden: () => {
                if (getRuntimeUploadSession(sessionId)?.settled) {
                  closePanel()
                }
              }
            })
          },
          onRowProgress: (uploadId, sentBytes) =>
            updateRuntimeUploadRow(sessionId, uploadId, { sentBytes }),
          onRowSettled: (uploadId, status) =>
            updateRuntimeUploadRow(sessionId, uploadId, { status }),
          isCancelled: (uploadId) => cancelledUploadIds.has(uploadId),
          onFinish: () => {
            settleRuntimeUploadSession(sessionId)
            // Why: no "done" replay on return; failures still get their own toast.
            if (panel && !panel.isShown()) {
              closePanel()
            }
          }
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
        .filter((result) => result.cancelled !== true),
      describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    )
  } catch (err) {
    // Why: only the error path tears the panel down immediately. On success it
    // owns its own exit, holding long enough to show how the drop ended.
    closePanel()
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'), {
      description: describeDropWorkspaceIfInactive(args.worktreeId, args.worktreePath)
    })
  }
}
