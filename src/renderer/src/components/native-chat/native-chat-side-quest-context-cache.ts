import type { SideQuestQuotedContext } from '@/lib/side-quest-context'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const contextByTerminalTabId = new Map<string, SideQuestQuotedContext>()

export function seedNativeChatSideQuestContext(
  terminalTabId: string,
  context: SideQuestQuotedContext
): void {
  setBoundedScopeCacheEntry(contextByTerminalTabId, terminalTabId, context)
}

export function readNativeChatSideQuestContext(
  terminalTabId: string
): SideQuestQuotedContext | null {
  return contextByTerminalTabId.get(terminalTabId) ?? null
}

export function clearNativeChatSideQuestContext(terminalTabId: string): void {
  contextByTerminalTabId.delete(terminalTabId)
}

export function clearNativeChatSideQuestContextCacheForTests(): void {
  contextByTerminalTabId.clear()
}
