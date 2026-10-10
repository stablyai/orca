import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'

/** A chat visual opened as its own workspace tab. Identity only, never the HTML. */
export type OpenChatVisualTabState = {
  target: RuntimeClientTarget
  sessionId: string
  file: string
  title: string | null
}

/** One tab per visual, so opening the same visual again focuses its tab. */
export function buildChatVisualTabId(
  worktreeId: string,
  visual: Pick<OpenChatVisualTabState, 'sessionId' | 'file'>
): string {
  return `${worktreeId}::chat-visual::${visual.sessionId}::${visual.file}`
}
