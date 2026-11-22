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
