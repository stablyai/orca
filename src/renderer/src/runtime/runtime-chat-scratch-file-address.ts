import { relativePathInsideRoot } from '../../../shared/cross-platform-path'

// `<host state dir>/chat-scratch/<32 hex>/<file>`, spelled with the host's own separators.
const CHAT_SCRATCH_FILE = /^(.+?[\\/]chat-scratch[\\/][0-9a-f]{32})[\\/].+$/

export type ChatScratchFileAddress = {
  /** The chat's folder exactly as its host spelled it; the host answers only its own. */
  root: string
  worktreeSelector: `path:${string}`
  relativePath: string
}

/** How a host addresses a file in a chat's scratch folder, which no workspace row contains. */
export function chatScratchFileAddress(absolutePath: string): ChatScratchFileAddress | null {
  const root = CHAT_SCRATCH_FILE.exec(absolutePath)?.[1]
  const relativePath = root ? relativePathInsideRoot(root, absolutePath) : null
  return root && relativePath ? { root, worktreeSelector: `path:${root}`, relativePath } : null
}
