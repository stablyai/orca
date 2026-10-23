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

/**
 * Case is kept, because case sensitivity can differ per directory and a folded key would merge
 * distinct files. Why not `normalizeRuntimePathForComparison`: it lowercases whole Windows paths.
 * `windows` (the local Windows client only) also reads a `//` path as UNC.
 */
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

/**
 * Null for non-edit views and unresolved owners. SSH files are keyed by connection target; a
 * retarget is caught by the guarded save.
 *
 * The key is not fixed for a live tab: an unpinned runtime tab resolves its pairing live (null
 * before the revision registry loads, the newest proven revision after). A caller must treat a key
 * change as a re-key or join of the existing record, never as a fresh record.
 */
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

/**
 * True when the identity's environment now names another machine. Pass the ids from one
 * `onRuntimeEnvironmentsRetired` event, not a long-lived list: a retired id can be re-paired.
 */
export function isEditorBufferIdentityRetired(
  identity: EditorBufferIdentity,
  retiredEnvironmentIds: readonly string[]
): boolean {
  return identity.environmentId !== null && retiredEnvironmentIds.includes(identity.environmentId)
}
