/** Folder beside the parent's transcript that holds omp side chats; omp's session lists and AI Vault skip it. */
export const OMP_SIDE_CHAT_DIR_NAME = '.orca-side-chats'

/** Names one side chat's own folder. Orca's omp extension injects the boundary and deletes the folder on exit. */
export const OMP_SIDE_CHAT_DIR_ENV = 'ORCA_OMP_SIDE_CHAT_DIR'

const SIDE_CHAT_SEGMENT_PATTERN = /[\\/]\.orca-side-chats[\\/]/i

/** omp mints its own session ids, so a side chat is recognized by where its transcript lives. */
export function isOmpSideChatTranscriptPath(path: string | null | undefined): boolean {
  return typeof path === 'string' && SIDE_CHAT_SEGMENT_PATTERN.test(path)
}

/** `<parent folder>/.orca-side-chats/<id>`, in the parent path's own separator so it holds on any host. */
export function ompSideChatDir(parentTranscriptPath: string, sideChatId: string): string | null {
  const cut = Math.max(
    parentTranscriptPath.lastIndexOf('/'),
    parentTranscriptPath.lastIndexOf('\\')
  )
  if (cut <= 0) {
    return null
  }
  const separator = parentTranscriptPath[cut]
  return [parentTranscriptPath.slice(0, cut), OMP_SIDE_CHAT_DIR_NAME, sideChatId].join(separator)
}
