import type { AppState } from '@/store'
import type { OpenFile } from '@/store/slices/editor'
import { joinPath } from '@/lib/path'
import { getOpenFilesForExternalFileChange, type EditorPathMutationTarget } from './editor-autosave'
import { resolveEditorModelOwner, resolvedEditorModelOwnerKey } from './editor-model-owner'
import type { EditorModelOwner } from './editor-model-owner'
import { editorBufferOwnerPathKey } from '@/store/slices/editor/buffers/editor-buffer-identity'

// Why not the model URI: it normalizes paths by the client's rules, so on a Windows client
// `/repo/a\b.ts` and `/repo/a/b.ts` on a POSIX host would collide.
function physicalFileKey(owner: EditorModelOwner, filePath: string): string | null {
  const ownerKey = resolvedEditorModelOwnerKey(owner)
  return ownerKey === null
    ? null
    : JSON.stringify([ownerKey, editorBufferOwnerPathKey(filePath, owner)])
}

/**
 * The physical file (host + path) a tab writes, shared by its edit and unstaged-diff tabs in every
 * workspace; a tab whose host is unknown, or that writes nothing, answers for itself.
 */
export function editorFileHoldKey(state: AppState, file: OpenFile): string {
  if (file.mode !== 'edit' && !(file.mode === 'diff' && file.diffSource === 'unstaged')) {
    return file.id
  }
  return physicalFileKey(resolveEditorModelOwner(file, state), file.filePath) ?? file.id
}

/**
 * Hold keys a path mutation (git discard) touches: the matched tabs' files, plus the file the path
 * names in the target workspace, which another workspace's tab may hold with none open here.
 */
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
  // Why: an unresolved owner keys per tab, so no other tab can share it.
  if (targetKey !== null) {
    keys.add(targetKey)
  }
  return keys
}

// Why: a slow SSH git restore can take a while; past this the dirty tabs say why they aren't saving.
export const AUTOSAVE_HOLD_BACKSTOP_MS = 120_000

export type AutoSaveHolds = {
  /** Pauses autosave for these hold keys until the returned release runs. */
  hold: (keys: ReadonlySet<string>) => () => void
  /** Whether a discard currently holds `file`'s autosave. */
  isHeld: (state: AppState, file: OpenFile) => boolean
  /** Re-shows the banner on dirty tabs of a hold past its backstop whose banner was dismissed. */
  flagOverdue: (state: AppState) => void
  dispose: () => void
}

/** Autosave pauses a git discard takes on a file in every workspace while git runs. */
export function createAutoSaveHolds(
  getState: () => AppState,
  onRelease: () => void
): AutoSaveHolds {
  // Held key → number of holds on it; `overdue` counts those past their backstop.
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
    // Why: git's outcome is still unknown, so the hold stays; the banner only explains the pause
    // and makes any later write an explicit choice.
    const backstop = window.setTimeout(() => {
      backstops.delete(backstop)
      isOverdue = true
      add(overdue, keys, 1)
      flagOverdue(getState())
    }, AUTOSAVE_HOLD_BACKSTOP_MS)
    backstops.add(backstop)
    add(counts, keys, 1)
    return () => {
      // Why: a discard finishing after the controller detached must not re-arm its timers.
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
