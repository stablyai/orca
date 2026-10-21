import { useLocalStructuredChatsInUse } from '@/runtime/local-structured-chats'

/**
 * Whether this window offers to carry on its chats. The offer is this machine's runtime's, so it is
 * asked only where that runtime can hold chats: the setting launches them, or it holds some. A
 * machine that never used structured chat builds no host to answer an empty offer.
 */
export function useNativeChatRestartOfferEnabled(): boolean {
  return useLocalStructuredChatsInUse()
}
