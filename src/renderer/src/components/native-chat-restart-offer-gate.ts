import { useLocalStructuredChatsInUse } from '@/runtime/local-structured-chats'

/** Ask only when local structured chats are enabled or present; unused installations must not start a host for an empty offer. */
export function useNativeChatRestartOfferEnabled(): boolean {
  return useLocalStructuredChatsInUse()
}
