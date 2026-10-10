import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from './connection-context'
import { getRuntimeTargetForFileOwner } from './file-owner-runtime-target'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner'

const USER_FILE_ACCESS: LocalFileAccess = { kind: 'user-file' }
const CHAT_IMAGE_ACCESS: LocalFileAccess = { kind: 'chat-image' }

/** For a path the user named by a gesture (click, drop, typed path); never for document content. */
export function userNamedFileAccess(): LocalFileAccess {
  return USER_FILE_ACCESS
}

/**
 * For an image a chat transcript or composer shows. Main reads any local image file in place, by
 * its real type, and refuses network shares, so it is safe for content no one clicked.
 */
export function chatImageAccess(): LocalFileAccess {
  return CHAT_IMAGE_ACCESS
}

/**
 * For acting on a document the user opened: renaming it (to any path the user typed) or inserting
 * an image next to it, which main keeps inside the document's own folder.
 */
export function documentFolderAccess(documentPath: string): LocalFileAccess {
  return { kind: 'document-folder', documentPath }
}

/** For a file a document's content references; main limits it to the document's roots or folder. */
export function documentResourceAccess(documentPath: string): LocalFileAccess {
  return { kind: 'document-resource', documentPath }
}

type EditorTabAccessFile = Pick<
  OpenFile,
  | 'filePath'
  | 'relativePath'
  | 'worktreeId'
  | 'runtimeEnvironmentId'
  | 'externalSshTargetId'
  | 'readOnly'
  | 'liveTail'
>

/** A read-only tab named by absolute path is this computer's file: an AI Vault log or a client-local link. */
export function isClientLocalReadOnlyTab(
  file: Pick<OpenFile, 'filePath' | 'relativePath' | 'readOnly' | 'liveTail'>
): boolean {
  return file.readOnly === true && (file.liveTail === true || file.relativePath === file.filePath)
}

/**
 * The file access a persisted editor tab reads and saves with. A tab the user opened outside its owner's
 * root (a floating-workspace tab, or one stored with an absolute path) is user-named, so it reads
 * the same before and after a restart; every other tab stays inside its project root.
 */
export function editorTabFileAccess(
  state: WorktreeRuntimeOwnerState,
  file: EditorTabAccessFile
): LocalFileAccess | undefined {
  // Why: these are client-local files the user opened, whatever the worktree's host.
  if (isClientLocalReadOnlyTab(file)) {
    return USER_FILE_ACCESS
  }
  const owner = getRuntimeTargetForFileOwner(state, file.worktreeId, file.runtimeEnvironmentId)
  // Why `!owner`: rows that disagree may put the path on another host.
  if (file.externalSshTargetId?.trim() || owner?.kind !== 'local') {
    return undefined
  }
  const outsideOwnerRoot =
    file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID || file.relativePath === file.filePath
  // Why null only: an SSH, ambiguous or not-yet-loaded owner may mean the path lives on another host.
  if (!outsideOwnerRoot || getConnectionIdForFile(file.worktreeId, file.filePath) !== null) {
    return undefined
  }
  return USER_FILE_ACCESS
}

/**
 * The write access for acting on an open tab's file (rename, image insert) when the tab is
 * user-named, else none, so project tabs keep their project checks.
 */
export function editorTabDocumentFolderAccess(
  state: WorktreeRuntimeOwnerState,
  file: EditorTabAccessFile
): LocalFileAccess | undefined {
  // Why: a read-only tab (an AI Vault log, possibly in an SSH workspace) is never written.
  if (file.readOnly === true) {
    return undefined
  }
  return editorTabFileAccess(state, file)?.kind === 'user-file'
    ? documentFolderAccess(file.filePath)
    : undefined
}
