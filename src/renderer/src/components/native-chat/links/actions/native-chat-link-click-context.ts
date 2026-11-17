import { createContext, useContext } from 'react'
import type { NativeChatFileOpener } from './use-native-chat-file-link-click'
import type { CommentMarkdownLinkClickHandler } from '@/components/comment-markdown/comment-markdown-element-renderers'

/** The chat's one link handler, provided by its session view; undefined where the chat cannot open links. */
export const NativeChatLinkClickContext = createContext<
  CommentMarkdownLinkClickHandler | undefined
>(undefined)

/** Every chat surface that renders a link reads the handler here; outside a session view there is none. */
export function useNativeChatLinkClick(): CommentMarkdownLinkClickHandler | undefined {
  return useContext(NativeChatLinkClickContext)
}

/** Explicit open buttons' file actions, which bypass link-click settings and the link popover. */
export const NativeChatFileOpenContext = createContext<NativeChatFileOpener | undefined>(undefined)

export function useNativeChatFileOpen(): NativeChatFileOpener | undefined {
  return useContext(NativeChatFileOpenContext)
}
