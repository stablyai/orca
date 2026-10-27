import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { resolveEditorModelOwner, resolvedEditorModelOwnerKey } from './editor-model-owner'
import type { EditorModelOwner } from './editor-model-owner'
import {
  editorBufferOwnerPathKey,
  isLocalWindowsEditorOwner
} from '@/store/slices/editor/buffers/editor-buffer-identity'
import { parseWslUncPath } from '../../../../shared/wsl-paths'

// Use host path rules: Windows model-URI normalization would conflate distinct backslash/slash paths on POSIX hosts.
function physicalFileKey(owner: EditorModelOwner, filePath: string): string | null {
  const ownerKey = resolvedEditorModelOwnerKey(owner)
  if (ownerKey === null) {
    return null
  }
  // Unify WSL UNC aliases using a tuple so a real share named wsl cannot collide.
  const wsl = isLocalWindowsEditorOwner(owner) ? parseWslUncPath(filePath) : null
  const pathKey = wsl
    ? ['wsl', wsl.distro.toLowerCase(), wsl.linuxPath]
    : editorBufferOwnerPathKey(filePath, owner)
  return JSON.stringify([ownerKey, pathKey])
}

/** Share physical host/path holds across edit and unstaged-diff views; unresolved or non-writing tabs keep private IDs. */
export function editorFileHoldKey(state: AppState, file: OpenFile): string {
  if (file.mode !== 'edit' && !(file.mode === 'diff' && file.diffSource === 'unstaged')) {
    return file.id
  }
  return editorPathHoldKey(state, file, file.filePath) ?? file.id
}

/** The physical file `filePath` names on `owner`'s host; null while that host is unknown. */
export function editorPathHoldKey(
  state: AppState,
  owner: Parameters<typeof resolveEditorModelOwner>[0],
  filePath: string
): string | null {
  return physicalFileKey(resolveEditorModelOwner(owner, state), filePath)
}

/** Hold matched tabs plus the target physical path, including views opened only in other workspaces. */
export function pathMutationHoldKeys(
  state: AppState,
  target: EditorPathMutationTarget
): Set<string> {
  const keys = new Set(
    getOpenFilesForExternalFileChange(state.openFiles, target).map((file) =>
      editorFileHoldKey(state, file)
    )
  )
  const targetKey = physicalFileKey(
    resolveEditorModelOwner(
      {
        worktreeId: target.worktreeId,
        ...(Object.hasOwn(target, 'runtimeEnvironmentId')
          ? { runtimeEnvironmentId: target.runtimeEnvironmentId }
          : {})
      },
      state
    ),
    joinPath(target.worktreePath, target.relativePath)
  )
  // Unknown owners remain private per-tab keys and cannot supply shared holds.
  if (targetKey !== null) {
    keys.add(targetKey)
  }
  return keys
}

// Explain prolonged autosave holds without releasing a potentially slow SSH discard.
export const AUTOSAVE_HOLD_BACKSTOP_MS = 120_000

export type AutoSaveHolds = {
  /** Pauses autosave for these hold keys until the returned release runs. */
  hold: (keys: ReadonlySet<string>) => () => void
  isHeld: (state: AppState, file: OpenFile) => boolean
  /** Re-show dismissed banners on dirty tabs when their hold exceeds its backstop. */
  flagOverdue: (state: AppState) => void
  dispose: () => void
}

export function createAutoSaveHolds(
  getState: () => AppState,
  onRelease: () => void
): AutoSaveHolds {
  const counts = new Map<string, number>()
  const overdue = new Map<string, number>()
  const backstops = new Set<number>()
  let disposed = false

  const add = (map: Map<string, number>, keys: ReadonlySet<string>, delta: 1 | -1): void => {
    for (const key of keys) {
      const count = (map.get(key) ?? 0) + delta
      if (count > 0) {
        map.set(key, count)
      } else {
        map.delete(key)
      }
    }
  }

  const flagOverdue = (state: AppState): void => {
    if (overdue.size === 0) {
      return
    }
    for (const tab of state.openFiles) {
      if (
        tab.isDirty &&
        tab.externalMutation !== 'changed' &&
        overdue.has(editorFileHoldKey(state, tab))
      ) {
        state.setExternalMutation(tab.id, 'changed')
      }
    }
  }

  const hold = (keys: ReadonlySet<string>): (() => void) => {
    let released = false
    let isOverdue = false
    // Keep the hold while Git’s outcome is unknown; explain the pause and require explicit choice for later writes.
    const backstop = window.setTimeout(() => {
      backstops.delete(backstop)
      isOverdue = true
      add(overdue, keys, 1)
      flagOverdue(getState())
    }, AUTOSAVE_HOLD_BACKSTOP_MS)
    backstops.add(backstop)
    add(counts, keys, 1)
    return () => {
      // Late discard settlement must not restart timers after controller disposal.
      if (released || disposed) {
        return
      }
      released = true
      window.clearTimeout(backstop)
      backstops.delete(backstop)
      add(counts, keys, -1)
      if (isOverdue) {
        add(overdue, keys, -1)
      }
      onRelease()
    }
  }

  return {
    hold,
    isHeld: (state, file) => counts.size > 0 && counts.has(editorFileHoldKey(state, file)),
    flagOverdue,
    dispose: () => {
      disposed = true
      for (const backstop of backstops) {
        window.clearTimeout(backstop)
      }
      backstops.clear()
      counts.clear()
      overdue.clear()
    }
  }
}
