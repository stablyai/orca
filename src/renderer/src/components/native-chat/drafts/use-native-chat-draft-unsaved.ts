import { useCallback, useSyncExternalStore } from 'react'
import {
  isNativeChatComposerDraftUnsaved,
  subscribeToNativeChatComposerDraft
} from './native-chat-composer-draft-store'

/** Whether storage refused this scope's draft, which then lasts only until Orca closes. */
export function useNativeChatComposerDraftUnsaved(scopeKey: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => subscribeToNativeChatComposerDraft(scopeKey, listener),
    [scopeKey]
  )
  return useSyncExternalStore(subscribe, () => isNativeChatComposerDraftUnsaved(scopeKey))
}
