// Model -> local-native-owner resolution for language-server navigation.
// The LSP session key is the worktree root (spec D6) and only client-local
// documents may join a session in S1 — a remote runtime or SSH owner has no
// native clangd behind it, and files opened outside any worktree get the
// expected no-navigation degradation (spec D10).
//
// SSH ownership has two spellings: a direct SSH-target tab carries
// `externalSshTargetId`, while a project-host SSH worktree carries its
// `hostId`/`identity.executionHostId` as `ssh:<target>` (resolved via
// `getConnectionId`). Both must route clangd through the relay `lsp.*`
// channel — earlier code only matched the direct spelling, so project-host
// SSH files fell through to the native adapter and failed (`spawn cmake
// ENOENT` on a remote POSIX path).
import type * as Monaco from 'monaco-editor'
import { normalizeNativeFilePath } from '../../../../../shared/language-server-path-normalization'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useAppStore } from '@/store'
import { getConnectionId } from '@/lib/connection-context'

export type LocalDocumentOwner = {
  filePath: string
  worktreeId: string
  worktreeRoot: string
  /** SSH target id when the document is on a remote host (ticket 17);
   *  null for local + WSL. Routes clangd through the relay lsp.* channel. */
  connectionId?: string | null
}

/** True when this edit tab could be client-local or SSH-owned (the worktree's
 *  execution host decides which — resolved in `resolveLocalDocumentOwner`).
 *  `runtimeEnvironmentId` set means a remote runtime (not clangd-backed). */
function isNavigationEligibleEditFile(file: OpenFile): boolean {
  return file.mode === 'edit' && (file.runtimeEnvironmentId ?? null) === null
}

/** True when this edit tab is an SSH-owned file (ticket 17): either a direct
 *  SSH-target tab (`externalSshTargetId`) or a project-host SSH worktree. */
export function isSshEditorFile(file: OpenFile): boolean {
  if (!isNavigationEligibleEditFile(file)) {
    return false
  }
  if (file.externalSshTargetId) {
    return true
  }
  // Project-host SSH worktree: getConnectionId resolves hostId `ssh:<target>`.
  const connectionId = getConnectionId(file.worktreeId)
  return typeof connectionId === 'string' && connectionId.length > 0
}

/** True when this edit tab lives on the client-local native host. */
export function isLocalNativeEditorFile(file: OpenFile): boolean {
  if (!isNavigationEligibleEditFile(file)) {
    return false
  }
  return !isSshEditorFile(file)
}

/**
 * Resolve the owning worktree for a path via its open editor tab. Handles
 * local-native files (S1), direct SSH-target files (ticket 17), and project-host
 * SSH worktrees — the latter two route clangd through the relay `lsp.*` channel.
 * Returns null when no edit tab owns the path, or when the SSH host cannot be
 * determined (`getConnectionId` returns undefined) — the caller degrades to
 * "no navigation for this document".
 */
export function resolveLocalDocumentOwner(filePath: string): LocalDocumentOwner | null {
  const state = useAppStore.getState()
  const key = normalizeNativeFilePath(filePath)
  const owner = state.openFiles.find(
    (file) => isNavigationEligibleEditFile(file) && normalizeNativeFilePath(file.filePath) === key
  )
  if (!owner) {
    return null
  }
  const worktree = state.allWorktrees().find((candidate) => candidate.id === owner.worktreeId)
  if (!worktree?.path) {
    return null
  }
  // Direct SSH-target tab beats the worktree's host resolution; fall back to
  // getConnectionId so a project-host SSH worktree (hostId `ssh:<target>`)
  // routes through the relay too.
  const directTargetId = owner.externalSshTargetId ?? null
  const connectionId = directTargetId ?? resolveConnectionIdForWorktree(owner.worktreeId)
  return {
    filePath: key,
    worktreeId: owner.worktreeId,
    worktreeRoot: normalizeNativeFilePath(worktree.path),
    connectionId
  }
}

/**
 * `getConnectionId` returns a string SSH target id, `null` (local), or
 * `undefined` (cannot determine — ambiguous owner). `undefined` must NOT
 * collapse to `null`: that would authorize a local clangd run on a remote
 * path. Map it to `null` only when it is provably local (null), else surface
 * the undeterminable case by returning null so navigation degrades safely
 * rather than mis-routing.
 */
function resolveConnectionIdForWorktree(worktreeId: string): string | null {
  const connectionId = getConnectionId(worktreeId)
  if (connectionId === undefined) {
    // Ambiguous owner: degrade (no navigation) rather than risk a local run.
    return null
  }
  return connectionId
}

/** Native path for a monaco model, or null for non-file models. */
export function nativePathForModel(model: Monaco.editor.ITextModel): string | null {
  if (model.uri.scheme !== 'file') {
    return null
  }
  // `Uri.file().fsPath` lowercases the Windows drive; normalize restores the
  // canonical identity shared with the main-process document table (spec D5).
  return normalizeNativeFilePath(model.uri.fsPath)
}

/** C/C++ selector languages that participate in native-host navigation. */
export const NATIVE_NAVIGATION_LANGUAGE_IDS = ['cpp', 'c'] as const

export function isNativeNavigationLanguage(languageId: string): boolean {
  return (NATIVE_NAVIGATION_LANGUAGE_IDS as readonly string[]).includes(languageId)
}
