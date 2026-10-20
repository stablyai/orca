import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import {
  editorModelOwnerKeyFor,
  getEditorModelOwnerKey,
  resolveEditorModelOwner
} from '@/components/editor/editor-model-owner'
import {
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/runtime-environment-revision'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import {
  isWindowsAbsolutePathLike,
  normalizeRuntimePathSeparators
} from '../../../../../../shared/cross-platform-path'
import { editorBufferIdOf, type EditorBufferIndex } from './editor-buffer-record'

/** The physical file a tab shows. Stays in this renderer; the workspace is never part of it. */
export type EditorBufferIdentity = {
  /** Host owner plus the normalized, exact-case path. */
  key: string
  environmentId: string | null
  /** Runtime pairing the tab was opened under; a retired pairing never joins its replacement. */
  revision: number | undefined
  /** The owner part of the default model URI. */
  modelOwnerKey: string
}

/**
 * Separators, drive letter and WSL alias are normalized; case is kept, because case sensitivity
 * can differ per directory and a folded key would merge distinct files.
 */
export function editorBufferPathKey(filePath: string): string {
  const wsl = parseWslUncPath(filePath)
  if (wsl) {
    return `//wsl/${wsl.distro.toLowerCase()}${wsl.linuxPath}`
  }
  if (!isWindowsAbsolutePathLike(filePath)) {
    return filePath
  }
  const slashed = normalizeRuntimePathSeparators(filePath)
  return /^[A-Za-z]:/.test(slashed) ? `${slashed[0].toLowerCase()}${slashed.slice(1)}` : slashed
}

/** Null for tabs that never share: non-edit views and owners not resolved yet. */
export function editorBufferIdentityOf(
  file: OpenFile,
  state: WorktreeOperationRouteState
): EditorBufferIdentity | null {
  if (file.mode !== 'edit') {
    return null
  }
  const owner = resolveEditorModelOwner(file, state)
  if (!owner.hostId) {
    return null
  }
  const { environmentId } = owner
  return {
    key: JSON.stringify([environmentId, owner.hostId, editorBufferPathKey(file.filePath)]),
    environmentId,
    revision: environmentId
      ? (file.operationProvenance?.generation.runtimePairingRevision ??
        getRuntimeEnvironmentRevision(environmentId))
      : undefined,
    modelOwnerKey: editorModelOwnerKeyFor(file, owner)
  }
}

/** Same file on a host proven to be the same machine; an unknown pairing can't prove a change. */
export function isSameEditorBuffer(a: EditorBufferIdentity, b: EditorBufferIdentity): boolean {
  if (a.key !== b.key) {
    return false
  }
  if (!a.environmentId || a.revision === undefined || b.revision === undefined) {
    return true
  }
  return (
    resolveContinuedRuntimeEnvironmentRevision(a.environmentId, a.revision) ===
    resolveContinuedRuntimeEnvironmentRevision(a.environmentId, b.revision)
  )
}

/** The owner of the model a tab mounts: its record's, so every view of a record shares one model. */
export function editorModelOwnerKeyOf(
  state: WorktreeOperationRouteState & { editorBufferIndex?: EditorBufferIndex },
  file: OpenFile
): string {
  return (
    state.editorBufferIndex?.keyByRecordId[editorBufferIdOf(state, file.id)]?.modelOwnerKey ??
    getEditorModelOwnerKey(file, state)
  )
}
