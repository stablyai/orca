import { useNativeChatSideQuestContext } from './use-native-chat-side-quest-context'
import type { NativeChatSideQuestReadiness } from './use-native-chat-side-quest-context'
import type { SideQuestQuotedContext } from '@/lib/side-quest-context'

export function isNativeChatSideQuestSendBlocked(readiness: NativeChatSideQuestReadiness): boolean {
  return readiness === 'starting' || readiness === 'failed'
}

export function isNativeChatSideQuestDraftEmpty(
  draft: string,
  context: SideQuestQuotedContext | null,
  imageCount: number
): boolean {
  return draft.trim() === '' && (context !== null || imageCount === 0)
}

export function useNativeChatSideQuestComposer(terminalTabId: string): {
  submitBlocked: boolean
  context: SideQuestQuotedContext | null
  readiness: NativeChatSideQuestReadiness
  clearContext: () => void
  wrapSubmittedText: (text: string, isSlashCommand: boolean) => string | null
} {
  const { context, readiness, clearContext, buildSubmittedText } =
    useNativeChatSideQuestContext(terminalTabId)
  return {
    submitBlocked: isNativeChatSideQuestSendBlocked(readiness),
    context,
    readiness,
    clearContext,
    wrapSubmittedText: buildSubmittedText
  }
}
