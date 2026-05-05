export type ChatId = string & { readonly __brand: 'ChatId' }

export function defaultChatId(worktreeId: string): ChatId {
  return `chat:${worktreeId}:default` as ChatId
}

export function isDefaultChatId(worktreeId: string, chatId: string): boolean {
  return chatId === defaultChatId(worktreeId)
}
