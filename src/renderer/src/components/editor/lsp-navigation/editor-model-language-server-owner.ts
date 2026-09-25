// Model -> local-native-owner resolution for language-server navigation.
// The LSP session key is the worktree root (spec D6) and only client-local
// documents may join a session in S1 — a remote runtime or SSH owner has no
// native clangd behind it, and files opened outside any worktree get the
// expected no-navigation degradation (spec D10).
import type * as Monaco from 'monaco-editor'
import { normalizeNativeFilePath } from '../../../../../shared/language-server-path-normalization'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { useAppStore } from '@/store'

export type LocalDocumentOwner = {
  filePath: string
  worktreeId: string
  worktreeRoot: string
  /** SSH target id when the document is on a remote host (ticket 17);
   *  null for local + WSL. Routes clangd through the relay lsp.* channel. */
  connectionId?: string | null
}

/** True when this edit tab is an SSH-owned file (ticket 17). */
export function isSshEditorFile(file: OpenFile): boolean {
  return (
    file.mode === 'edit' &&
    (file.runtimeEnvironmentId ?? null) === null &&
    !!file.externalSshTargetId
  )
}

/** True when this edit tab lives on the client-local native host. */
export function isLocalNativeEditorFile(file: OpenFile): boolean {
  return (
    file.mode === 'edit' &&
    (file.runtimeEnvironmentId ?? null) === null &&
    !file.externalSshTargetId
  )
}

/**
 * Resolve the owning worktree for a path via its open editor tab. Handles both
 * local-native files (S1) and SSH-owned files (ticket 17) — the latter route
 * clangd through the relay `lsp.*` channel. Returns null when no edit tab owns
 * the path — the caller degrades to "no navigation for this document".
 */
export function resolveLocalDocumentOwner(filePath: string): LocalDocumentOwner | null {
  const state = useAppStore.getState()
  const key = normalizeNativeFilePath(filePath)
  const owner = state.openFiles.find(
    (file) =>
      (isLocalNativeEditorFile(file) || isSshEditorFile(file)) &&
      normalizeNativeFilePath(file.filePath) === key
  )
  if (!owner) {
    return null
  }
  const worktree = state.allWorktrees().find((candidate) => candidate.id === owner.worktreeId)
  if (!worktree?.path) {
    return null
  }
  return {
    filePath: key,
    worktreeId: owner.worktreeId,
    worktreeRoot: normalizeNativeFilePath(worktree.path),
    connectionId: owner.externalSshTargetId ?? null
  }
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
