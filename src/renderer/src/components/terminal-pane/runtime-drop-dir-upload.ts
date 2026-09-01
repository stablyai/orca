// Shared core for uploading client-local paths into a runtime worktree's
// `.orca/drops` — used by terminal drops and the native chat composer so the
// two surfaces cannot diverge on the same operation.

import { toast } from 'sonner'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { importExternalPathsToRuntime } from '@/runtime/runtime-file-client'
import { reportTerminalDropUploadSkipsAndFailures } from './terminal-drop-upload-report'
import { isTerminalDropWindowsPathLike } from './terminal-drop-shell'
import { joinRuntimeTerminalDropDir } from './terminal-drop-worktree-path'

export type RuntimeDropDirUploadOwner = {
  runtimeEnvironmentId: string
  worktreeId: string
  worktreePath: string
  expectedExecutionHostId?: 'local' | `ssh:${string}`
  expectedSshTargetId?: string
  expectedSshConnectionGeneration?: number
}

/**
 * Upload paths into `${worktreePath}/.orca/drops` on the owning runtime (which
 * forwards to its own SSH target for nested worktrees) and return the
 * destination-side paths. Per-file skips/failures surface through the shared
 * drop toasts; returns null when the upload itself failed.
 */
export async function uploadPathsToRuntimeDropDir(
  paths: string[],
  owner: RuntimeDropDirUploadOwner,
  options: { loadingMessage: string; assertCurrent?: () => void }
): Promise<string[] | null> {
  const pending = toast.loading(options.loadingMessage)
  try {
    const { results } = await importExternalPathsToRuntime(
      {
        settings: { activeRuntimeEnvironmentId: owner.runtimeEnvironmentId },
        worktreeId: owner.worktreeId,
        worktreePath: owner.worktreePath,
        expectedExecutionHostId: owner.expectedExecutionHostId,
        expectedSshTargetId: owner.expectedSshTargetId,
        expectedSshConnectionGeneration: owner.expectedSshConnectionGeneration
      },
      paths,
      joinRuntimeTerminalDropDir(owner.worktreePath),
      { assertCurrent: options.assertCurrent }
    )
    const importedPaths = results
      .filter((result) => result.status === 'imported')
      .map((result) =>
        isTerminalDropWindowsPathLike(owner.worktreePath)
          ? result.destPath.replace(/\//g, '\\')
          : result.destPath
      )
    reportTerminalDropUploadSkipsAndFailures(
      results.filter((result) => result.status === 'skipped'),
      results.filter((result) => result.status === 'failed')
    )
    return importedPaths
  } catch (err) {
    toast.error(extractIpcErrorMessage(err, 'Failed to upload files.'))
    return null
  } finally {
    toast.dismiss(pending)
  }
}
