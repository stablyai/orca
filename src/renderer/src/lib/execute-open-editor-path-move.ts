import { useAppStore } from '@/store'
import { renameRuntimePath } from '@/runtime/runtime-file-mutation-client'
import type { RuntimeFileOperationArgs } from '@/runtime/runtime-file-client-types'
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
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { editorMoveOwnerFromContext, isOpenFileOnMoveOwner } from '@/lib/open-editor-move-owner'
import { documentFolderAccess } from '@/lib/local-file-access'
import { contentRekeyOutcome } from '@/runtime/layout-owner-content-rekeys'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'

let moveOperationCounter = 0

/** Quiesce saves, suppress source events, rename disk, rekey sessions atomically and verify destination echoes. Failed rename leaves store state untouched and releases suppression. */
export async function executeOpenEditorPathMove(args: {
  context: RuntimeFileOperationArgs
  fromPath: string
  toPath: string
  worktreeId: string
  worktreePath: string
  /** The moved file is a user-named document: main allows any destination, and the move back. */
  documentScoped?: boolean
}): Promise<void> {
  const { context, fromPath, toPath, worktreeId, worktreePath } = args
  const operationId = `editor-move-${(moveOperationCounter += 1)}`

  // Scope by host: identical absolute paths on other SSH/runtime/local hosts name untouched files.
  const moveState = useAppStore.getState()
  const owner = editorMoveOwnerFromContext(context, worktreeId)
  const affected = moveState.openFiles.filter(
    (f) => isPathInsideOrEqual(fromPath, f.filePath) && isOpenFileOnMoveOwner(moveState, f, owner)
  )

  // Suppress the whole move root per scope, including files opened under a moving directory after planning.
  const ownerSubOps: string[] = []
  const scopes = new Map<string, { worktreeId: string; owner: string | null }>()
  const addScope = (wtId: string, owner: string | null): void => {
    scopes.set(`${wtId}::${owner ?? 'local'}`, { worktreeId: wtId, owner })
  }
  addScope(worktreeId, runtimeEnvironmentIdOrLocalUnlessTwin(moveState, worktreeId))
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

  // Wait for autosaves so a trailing write cannot recreate the old path after rename.
  await Promise.all(affected.map((f) => requestEditorSaveQuiesce({ fileId: f.id })))

  try {
    await renameRuntimePath(
      context,
      fromPath,
      toPath,
      args.documentScoped ? documentFolderAccess(fromPath) : undefined
    )
  } catch (err) {
    for (const subOperationId of ownerSubOps) {
      settleEditorPathMove(subOperationId)
    }
    throw err
  }

  // Release source suppression only after rollback, including on errors, so late forward-rename events stay suppressed.
  try {
    // Capture host-close IDs before rekey changes them, but send only after commit.
    const mirrorState = useAppStore.getState()
    const mirroredAffected = affected.filter((f) => f.mirroredFromRuntimeSession)

    let rekeyResult = remapOpenEditorTabsForPathChange({
      fromPath,
      toPath,
      worktreePath,
      worktreeId,
      owner,
      moveOperationId: operationId
    })
    if (
      ORCA_LAYOUT_OWNER_IS_MAIN &&
      rekeyResult.ok &&
      !(await contentRekeyOutcome(affected.map((file) => file.id)))
    ) {
      rekeyResult = { ok: false, reason: 'stale' }
    }
    if (!rekeyResult.ok) {
      // Undo disk rename if editor rekey fails, or the open source session would point to a vanished path.
      let rollbackError: unknown
      try {
        await renameRuntimePath(
          context,
          toPath,
          fromPath,
          args.documentScoped ? documentFolderAccess(toPath) : undefined
        )
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

    // Close old mirrored host tabs after local rekey; close intent prevents snapshots resurrecting the old path.
    for (const file of mirroredAffected) {
      notifyHostOfMirroredEditorClose(mirrorState, file.worktreeId, file.id)
    }
  } finally {
    for (const subOperationId of ownerSubOps) {
      settleEditorPathMove(subOperationId)
    }
  }

  // Verify gated destinations proactively so dropped/coalesced watcher events cannot leave autosave blocked.
  const gatedTabIds = useAppStore
    .getState()
    .openFiles.filter((f) => f.pendingSelfMoveEcho?.operationId === operationId)
    .map((f) => f.id)
  if (gatedTabIds.length > 0) {
    verifyLatchedMoveDestinations(worktreePath, context.connectionId, gatedTabIds)
  }
}
