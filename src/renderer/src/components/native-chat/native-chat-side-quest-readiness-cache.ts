import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

const readinessByTerminalTabId = new Map<string, Promise<boolean>>()

export function seedNativeChatSideQuestReadiness(
  terminalTabId: string,
  readiness: Promise<boolean>
): void {
  setBoundedScopeCacheEntry(readinessByTerminalTabId, terminalTabId, readiness)
}

export function readNativeChatSideQuestReadiness(terminalTabId: string): Promise<boolean> | null {
  return readinessByTerminalTabId.get(terminalTabId) ?? null
}

export function clearNativeChatSideQuestReadinessCacheForTests(): void {
  readinessByTerminalTabId.clear()
}
