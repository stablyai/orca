import type { OpenFile } from '../types/open-file'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { resolveEditorModelOwner } from '@/components/editor/editor-model-owner'
import { isLocalWindowsDesktopClient } from '@/lib/desktop-window-chrome'
import { resolveContinuedRuntimeEnvironmentRevision } from '@/runtime/runtime-environment-revision'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import { normalizeRuntimePathSeparators } from '../../../../../../shared/cross-platform-path'

/** The physical file an edit tab shows. Renderer-local; the workspace is never part of it. */
export type EditorBufferIdentity = {
  /** Environment, host, pairing root, SSH endpoint and path key: equal keys are one file. */
  key: string
  environmentId: string | null
}

/** `windows` or `posix` only when verified for the host; `unknown` never folds an ambiguous path. */
export type EditorBufferHostPathFlavor = 'windows' | 'posix' | 'unknown'

/** Facts about the tab's execution host, supplied per tab by the caller. */
export type EditorBufferHostFacts = {
  /**
   * The SSH endpoint this tab captured when it opened. Never the target's current endpoint: a
   * target id can be edited in place to name another machine, and a live lookup would then match
   * an old tab to the new machine. Undefined for an SSH tab means it never shares.
   */
  capturedSshEndpoint?: string
  /** Verified path flavor of a remote host. The local client's flavor is detected here. */
  remotePathFlavor?: EditorBufferHostPathFlavor
}

/** A WSL key is a tuple, so no real path string can ever equal it. */
export type EditorBufferPathKey = string | readonly ['wsl', string, string]

/**
 * Case is kept, because case sensitivity can differ per directory and a folded key would merge
 * distinct files. Why not `normalizeRuntimePathForComparison`: it lowercases whole Windows paths.
 */
export function editorBufferPathKey(
  filePath: string,
  flavor: EditorBufferHostPathFlavor,
  foldWslAliases = false
): EditorBufferPathKey {
  const wsl = foldWslAliases ? parseWslUncPath(filePath) : null
  if (wsl) {
    // Distro names are case-insensitive; the Linux path under them is not.
    return ['wsl', wsl.distro.toLowerCase(), wsl.linuxPath]
  }
  // Absolute POSIX paths start with `/`, so a drive or `\\` prefix proves Windows. `//` does not.
  const drive = /^[A-Za-z]:[\\/]/.test(filePath)
  const unc = filePath.startsWith('\\\\') || (flavor === 'windows' && filePath.startsWith('//'))
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

/**
 * The path key of a file on a resolved owner, using only what the renderer verifies itself: a
 * remote host's flavor is unknown here, so only paths that prove Windows (drive, `\\`) fold.
 */
export function editorBufferOwnerPathKey(
  filePath: string,
  owner: { environmentId: string | null; hostId: string | null }
): EditorBufferPathKey {
  const localWindows =
    parseExecutionHostId(owner.hostId)?.kind === 'local' &&
    !owner.environmentId &&
    isLocalWindowsDesktopClient()
  return editorBufferPathKey(filePath, localWindows ? 'windows' : 'unknown', localWindows)
}

/**
 * Null for tabs that never share: non-edit views, unresolved owners, and SSH tabs with no captured
 * endpoint.
 *
 * The key is not fixed for a live tab: an unpinned runtime tab resolves its pairing live (null
 * before the revision registry loads, the newest proven revision after). A caller must treat a key
 * change as a re-key or join of the existing record, never as a fresh record.
 */
export function editorBufferIdentityOf(
  file: OpenFile,
  state: WorktreeOperationRouteState,
  hostFacts: EditorBufferHostFacts
): EditorBufferIdentity | null {
  if (file.mode !== 'edit') {
    return null
  }
  const { environmentId, hostId } = resolveEditorModelOwner(file, state)
  const host = parseExecutionHostId(hostId)
  if (!host) {
    return null
  }
  const sshEndpoint = host.kind === 'ssh' ? (hostFacts.capturedSshEndpoint ?? null) : null
  if (host.kind === 'ssh' && !sshEndpoint) {
    return null
  }
  // A same-host re-pair resolves to the revision it continues; an unproven one stays apart.
  const revisionRoot = environmentId
    ? (resolveContinuedRuntimeEnvironmentRevision(
        environmentId,
        file.operationProvenance?.generation.runtimePairingRevision
      ) ?? null)
    : null
  // `wsl$` and `wsl.localhost` name one distro only on the local Windows client; a paired web
  // client (including `orca serve` on Windows) keeps them apart, as today.
  const localWindows = host.kind === 'local' && !environmentId && isLocalWindowsDesktopClient()
  const flavor = localWindows
    ? 'windows'
    : host.kind === 'local' && !environmentId
      ? 'unknown'
      : (hostFacts.remotePathFlavor ?? 'unknown')
  return {
    key: JSON.stringify([
      environmentId,
      host.id,
      revisionRoot,
      sshEndpoint,
      editorBufferPathKey(file.filePath, flavor, localWindows)
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

/**
 * A record id no identity key can equal. Records on a retired environment move here and are never
 * merged into the replacement machine's records, even with an identical path and baseline.
 */
export function detachedEditorBufferId(viewId: string): string {
  return `detached:${viewId}`
}
