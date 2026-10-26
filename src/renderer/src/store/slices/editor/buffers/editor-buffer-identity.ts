import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { normalizeRuntimePathSeparators } from '../../../../../../shared/cross-platform-path'

/** The physical file an edit tab shows. Renderer-local; the workspace is never part of it. */
export type EditorBufferIdentity = {
  /** Environment, host, pairing root and path key: equal keys are one file. */
  key: string
  environmentId: string | null
}

/** Preserve path case: sensitivity can differ per directory and normalizeRuntimePathForComparison folds all Windows paths. Only local Windows clients interpret // as UNC. */
export function editorBufferPathKey(filePath: string, windows: boolean): string {
  // Absolute POSIX paths start with `/`, so a drive or `\\` prefix proves Windows. `//` does not.
  const drive = /^[A-Za-z]:[\\/]/.test(filePath)
  const unc = filePath.startsWith('\\\\') || (windows && filePath.startsWith('//'))
  if (!drive && !unc) {
    return filePath
  }
  const slashed = normalizeRuntimePathSeparators(filePath)
  if (drive) {
    return `${slashed[0].toLowerCase()}${slashed.slice(1)}`
  }
  // The UNC server is a case-insensitive host name, as in the Monaco model URI's authority.
  const serverEnd = slashed.indexOf('/', 2)
  return serverEnd === -1
    ? slashed.toLowerCase()
    : `${slashed.slice(0, serverEnd).toLowerCase()}${slashed.slice(serverEnd)}`
}

type EditorPathOwner = { environmentId: string | null; hostId: string | null }

/** The owner is this machine and this client is the local Windows desktop app. */
export function isLocalWindowsEditorOwner(owner: EditorPathOwner): boolean {
  return (
    parseExecutionHostId(owner.hostId)?.kind === 'local' &&
    !owner.environmentId &&
    isLocalWindowsDesktopClient()
  )
}

/** The path key of a file on a resolved owner. Remote paths fold only when they prove Windows. */
export function editorBufferOwnerPathKey(filePath: string, owner: EditorPathOwner): string {
  return editorBufferPathKey(filePath, isLocalWindowsEditorOwner(owner))
}

/** Null for nonedit/unresolved owners; SSH uses target identity plus guarded-save retarget checks. Unpinned runtime keys follow live proven pairing revisions; changed keys must rekey/join existing records, never discard them as fresh. */
export function editorBufferIdentityOf(
  file: OpenFile,
  state: WorktreeOperationRouteState
): EditorBufferIdentity | null {
  if (file.mode !== 'edit') {
    return null
  }
  const owner = resolveEditorModelOwner(file, state)
  const host = parseExecutionHostId(owner.hostId)
  if (!host) {
    return null
  }
  const { environmentId } = owner
  // A same-host re-pair resolves to the revision it continues; an unproven one stays apart.
  const revisionRoot = environmentId
    ? (resolveContinuedRuntimeEnvironmentRevision(
        environmentId,
        file.operationProvenance?.generation.runtimePairingRevision
      ) ?? null)
    : null
  return {
    key: JSON.stringify([
      environmentId,
      host.id,
      revisionRoot,
      editorBufferOwnerPathKey(file.filePath, owner)
    ]),
    environmentId
  }
}

/** Check one retirement event’s IDs for machine replacement; long-lived lists become stale when IDs are re-paired. */
export function isEditorBufferIdentityRetired(
  identity: EditorBufferIdentity,
  retiredEnvironmentIds: readonly string[]
): boolean {
  return identity.environmentId !== null && retiredEnvironmentIds.includes(identity.environmentId)
}
