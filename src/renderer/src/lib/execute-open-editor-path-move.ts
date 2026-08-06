import { useAppStore } from '@/store'
import { renameRuntimePath, type RuntimeFileOperationArgs } from '@/runtime/runtime-file-client'
import { requestEditorSaveQuiesce } from '@/components/editor/editor-autosave'
import {
  beginEditorPathMove,
  settleEditorPathMove
} from '@/components/editor/editor-path-move-inflight'
import {
  isPathInsideOrEqual,
  remapOpenEditorTabsForPathChange
} from '@/lib/remap-open-editor-tabs-for-path-change'
import { verifyLatchedMoveDestinations } from '@/hooks/useEditorExternalWatch'
import { notifyHostOfMirroredEditorClose } from '@/runtime/close-mirrored-editor-tab'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'

let moveOperationCounter = 0

/**
 * Coordinates an Orca-owned move as one editor transaction: quiesce affected
 * saves, register in-flight source suppression, run the on-disk rename, then
 * atomically rekey the open sessions in place (installing the content-verify
 * gate) and re-verify any destination echo that was latched before the rekey.
 * On failure the store is untouched — only the suppression scope is released.
 */
export async function executeOpenEditorPathMove(args: {
  context: RuntimeFileOperationArgs
  fromPath: string
  toPath: string
  worktreeId: string
  worktreePath: string
}): Promise<void> {
  const { context, fromPath, toPath, worktreeId, worktreePath } = args
  const operationId = `editor-move-${(moveOperationCounter += 1)}`

  // Host-scoped: the same abs path on another host (2nd SSH connection, local vs
  // runtime) is a distinct file the rename never touched — keep it out of the move.
  const moveState = useAppStore.getState()
  const initiatingHostId = getExecutionHostIdForWorktree(moveState, worktreeId)
  const affected = moveState.openFiles.filter(
    (f) =>
      isPathInsideOrEqual(fromPath, f.filePath) &&
      getExecutionHostIdForWorktree(moveState, f.worktreeId) === initiatingHostId
  )

  // Suppress the move ROOT (prefix-matched) per scope, always including the
  // initiating one, so a file opened UNDER a moving dir mid-rename is covered
  // even though it wasn't in `affected`.
  const ownerSubOps: string[] = []
  const scopes = new Map<string, { worktreeId: string; owner: string | null }>()
  const addScope = (wtId: string, owner: string | null): void => {
    scopes.set(`${wtId}::${owner ?? 'local'}`, { worktreeId: wtId, owner })
  }
  addScope(worktreeId, getRuntimeEnvironmentIdForWorktree(moveState, worktreeId))
  for (const f of affected) {
    addScope(f.worktreeId, f.runtimeEnvironmentId?.trim() || null)
  }
  for (const [key, scope] of scopes) {
    const subOperationId = `${operationId}::${key}`
    ownerSubOps.push(subOperationId)
    beginEditorPathMove({
      operationId: subOperationId,
      worktreeId: scope.worktreeId,
      runtimeEnvironmentId: scope.owner,
      sourcePaths: [fromPath]
    })
  }

  // Let any in-flight autosave settle so a trailing write can't recreate the old
  // path after the rename.
  await Promise.all(affected.map((f) => requestEditorSaveQuiesce({ fileId: f.id })))

  try {
    await renameRuntimePath(context, fromPath, toPath)
  } catch (err) {
    // Rename never landed — release the source suppression immediately.
    for (const subOperationId of ownerSubOps) {
      settleEditorPathMove(subOperationId)
    }
    throw err
  }

  // The on-disk rename has committed. Guarantee the source suppression is
  // released on every exit path, but only AFTER any rollback rename runs so a
  // late forward-rename delete event stays suppressed during rollback.
  try {
    // Capture host-close resolution from the PRE-rekey store (mirrored tab ids
    // change on rekey), but don't send it yet — only a committed rekey should
    // close the host's authoritative tab.
    const mirrorState = useAppStore.getState()
    const mirroredAffected = affected.filter((f) => f.mirroredFromRuntimeSession)

    // Commit: retarget the live sessions in place (the rekey installs the gate +
    // provenance on dirty destinations).
    const rekeyResult = remapOpenEditorTabsForPathChange({
      fromPath,
      toPath,
      worktreePath,
      worktreeId,
      moveOperationId: operationId
    })
    if (!rekeyResult.ok) {
      // The disk rename succeeded but the editor state couldn't be retargeted
      // (a destination collision or stale plan). Undo the on-disk move so the
      // still-open source session isn't stranded pointing at a vanished path.
      let rollbackError: unknown
      try {
        await renameRuntimePath(context, toPath, fromPath)
      } catch (err) {
        rollbackError = err
      }
      const base = `Could not retarget open editors for the move (${rekeyResult.reason}).`
      throw new Error(
        rollbackError
          ? `${base} The on-disk move could not be undone and the file may remain at the new path: ${
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
            }`
          : base
      )
    }

    // Rekey detached mirrored tabs to local; close the host's old-path tab so its
    // snapshot can't resurrect the old path (the close intent suppresses re-mirroring).
    for (const file of mirroredAffected) {
      notifyHostOfMirroredEditorClose(mirrorState, file.worktreeId, file.id)
    }
  } finally {
    for (const subOperationId of ownerSubOps) {
      settleEditorPathMove(subOperationId)
    }
  }

  // Proactively verify every gated tab so the autosave gate resolves even if the
  // destination watcher event never arrives (down / dropped / coalesced).
  const gatedTabIds = useAppStore
    .getState()
    .openFiles.filter((f) => f.pendingSelfMoveEcho?.operationId === operationId)
    .map((f) => f.id)
  if (gatedTabIds.length > 0) {
    verifyLatchedMoveDestinations(worktreePath, context.connectionId, gatedTabIds)
  }
}
