import { createContext, useCallback, useContext, type ReactNode, type RefObject } from 'react'
import type { NativeChatComposerHandle } from './native-chat-composer-types'

/** Inserts text at the composer's caret for the chat pane the code block is rendered in. */
export type NativeChatComposerInsert = (text: string) => void

const NativeChatComposerInsertContext = createContext<NativeChatComposerInsert | null>(null)

/** The caret-insert callback for this chat pane, or null outside a composer host. */
export function useNativeChatComposerInsert(): NativeChatComposerInsert | null {
  return useContext(NativeChatComposerInsertContext)
}

/** Wraps a transcript so its code blocks can drop a command at this pane's composer caret.
 * `enabled` is false while a prompt card owns the input, so the button hides instead of no-opping. */
export function NativeChatComposerInsertHost({
  composerRef,
  enabled = true,
  children
}: {
  composerRef: RefObject<NativeChatComposerHandle | null>
  enabled?: boolean
  children: ReactNode
}): React.JSX.Element {
  const insert = useCallback(
    (text: string): void => {
      composerRef.current?.insertTypedText(text)
    },
    [composerRef]
  )
  return (
    <NativeChatComposerInsertContext.Provider value={enabled ? insert : null}>
      {children}
    </NativeChatComposerInsertContext.Provider>
  )
}
