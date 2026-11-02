import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import { subscribeToNativeChatComposerDraft } from './native-chat-composer-draft-store'
import {
  nativeChatPastedTextAdmission,
  nativeChatPastedTextState
} from './native-chat-composer-pasted-text-references'

const Scope = createContext('')
export const NativeChatPastedTextScopeProvider = Scope.Provider

export function useNativeChatPastedTextState(token: string): string | null {
  const scope = useContext(Scope)
  const subscribe = useCallback(
    (changed: () => void) => subscribeToNativeChatComposerDraft(scope, changed),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPastedTextState(scope, token))
}

export function useNativeChatPastedTextAdmission(scope: string) {
  const subscribe = useCallback(
    (changed: () => void) => subscribeToNativeChatComposerDraft(scope, changed),
    [scope]
  )
  return useSyncExternalStore(subscribe, () => nativeChatPastedTextAdmission(scope))
}
