import { createContext, useContext } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/comment-markdown-element-renderers'

/** The chat's one link handler, provided by its session view; undefined where the chat cannot open links. */
export const NativeChatLinkClickContext = createContext<
  CommentMarkdownLinkClickHandler | undefined
>(undefined)

/** Every chat surface that renders a link reads the handler here; outside a session view there is none. */
export function useNativeChatLinkClick(): CommentMarkdownLinkClickHandler | undefined {
  return useContext(NativeChatLinkClickContext)
}
