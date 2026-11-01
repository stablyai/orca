import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { createNativeChatTabOwnerSelector } from './native-chat-file-link'

/** Owning workspace of a chat tab; launch identity must not wait on its directory resolving. */
export function useNativeChatTabOwnerWorktreeId(tabId: string): string | null {
  const selectOwner = useMemo(() => createNativeChatTabOwnerSelector(tabId), [tabId])
  return useAppStore(selectOwner)
}
