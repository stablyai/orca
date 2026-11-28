import { relativePathInsideRoot } from '../../../file-access/cross-platform-path'
import { formatNativeChatFileReference } from './agent-image-paste'

/** A picked workspace-relative path as the agent reads it from its own folder, when the chat runs
 *  in a workspace sub-folder (`folder`, workspace-relative, `/`-separated). */
export function mentionPathFromChatFolder(path: string, folder: string): string {
  const from = folder.split('/')
  const to = path.split('/')
  let shared = 0
  // The last segment is the file (or a folder's trailing ''), never a shared directory.
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) {
    shared++
  }
  return `${'../'.repeat(from.length - shared)}${to.slice(shared).join('/')}` || './'
}

/** The `@` reference for a picked workspace file in a chat its host runs in `launchDirectory`;
 *  undefined when that folder is the workspace itself or outside it, keeping the default. */
export function chatFolderFileReference(
  path: string,
  workspacePath: string,
  launchDirectory: string
): string | undefined {
  const folder = relativePathInsideRoot(workspacePath, launchDirectory)
  return folder ? formatNativeChatFileReference(mentionPathFromChatFolder(path, folder)) : undefined
}
