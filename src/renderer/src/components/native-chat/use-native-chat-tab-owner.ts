import { useAppStore } from '@/store'
import { findNativeChatTabOwnerWorktreeId } from './native-chat-file-link'

/** Owning workspace of a chat tab; launch identity must not wait on its directory resolving. */
export function useNativeChatTabOwnerWorktreeId(tabId: string): string | null {
  return useAppStore((state) => findNativeChatTabOwnerWorktreeId(state, tabId))
}
