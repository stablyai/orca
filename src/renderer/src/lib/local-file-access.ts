import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { LocalFileAccess } from '../../../shared/local-file-access'
import type { OpenFile } from '@/store/slices/editor'
import { getConnectionIdForFile } from './connection-context'
import { getRuntimeTargetForFileOwner } from './file-owner-runtime-target'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'

const USER_FILE_ACCESS: LocalFileAccess = { kind: 'user-file' }
const CHAT_IMAGE_ACCESS: LocalFileAccess = { kind: 'chat-image' }
const PROJECT_FOLDER_LINK_ACCESS: LocalFileAccess = { kind: 'project-folder-link' }

/** For a path the user named by a gesture (click, drop, typed path); never for document content. */
export function userNamedFileAccess(): LocalFileAccess {
  return USER_FILE_ACCESS
}

/** List a folder reached through a project symlink that leads outside; main verifies the link. */
export function projectFolderLinkAccess(): LocalFileAccess {
  return PROJECT_FOLDER_LINK_ACCESS
}

/** Read content-referenced local images by actual type; main refuses network shares even without a user gesture. */
export function chatImageAccess(): LocalFileAccess {
  return CHAT_IMAGE_ACCESS
}

/** User-opened document actions may rename to a typed path; image insertion remains inside its folder. */
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
  file: Pick<OpenFile, 'filePath' | 'relativePath' | 'readOnly' | 'liveTail'> &
    Partial<Pick<OpenFile, 'runtimeEnvironmentId'>>
): boolean {
  return (
    file.readOnly === true &&
    // Why: a server-granted file (live or restored without its grant) names a server path.
    !file.runtimeEnvironmentId?.trim() &&
    (file.liveTail === true || file.relativePath === file.filePath)
  )
}

/** Persist gesture-based access for user-opened absolute/floating files across restart; other tabs remain bounded to project roots. */
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

/** Allow user-named rename/image-insert access only for eligible open files; project tabs retain project checks. */
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
