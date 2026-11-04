import { createContext, useContext } from 'react'
import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'

/** The chat's one link handler, provided by its session view; undefined where the chat cannot open links. */
export const NativeChatLinkClickContext = createContext<
  CommentMarkdownLinkClickHandler | undefined
>(undefined)

/** Every chat surface that renders a link reads the handler here, so no card or row can be mounted without it. */
export function useNativeChatLinkClick(): CommentMarkdownLinkClickHandler | undefined {
  return useContext(NativeChatLinkClickContext)
}
