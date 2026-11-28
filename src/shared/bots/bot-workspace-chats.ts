// Which chat each of a bot's workspaces sits under, for `bots.chatTree`.
import type { BotChatTreeExtra, BotChatTreePlaced } from './bot-chat-tree-model'

/** Each workspace under the chat of its newest Dispatch; one no Dispatch ran in sits under Home. */
export function botWorkspaceChats(
  placed: readonly BotChatTreePlaced[],
  extras: readonly BotChatTreeExtra[],
  home: string,
  homeWorkspaceIds: readonly string[] = []
): Record<string, string> {
  const newest = new Map<string, { chatId: string; at: number }>()
  const consider = (worktreeId: string | null | undefined, chatId: string, at: number): void => {
    const current = worktreeId ? newest.get(worktreeId) : undefined
    if (worktreeId && (!current || current.at < at)) {
      newest.set(worktreeId, { chatId, at })
    }
  }
  for (const { dispatch, chatId } of placed) {
    consider(dispatch.worktreeId, chatId, dispatch.at)
  }
  // A workspace a Dispatch ran in stays with that Dispatch's chat, whatever else works there later.
  const placedWorktrees = new Set(newest.keys())
  for (const extra of extras) {
    if (!placedWorktrees.has(extra.worker.worktreeId ?? '')) {
      consider(extra.worker.worktreeId, home, extra.at)
    }
  }
  const map: Record<string, string> = {}
  for (const worktreeId of homeWorkspaceIds) {
    map[worktreeId] = home
  }
  for (const [worktreeId, { chatId }] of newest) {
    map[worktreeId] = chatId
  }
  return map
}
