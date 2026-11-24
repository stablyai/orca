import { createContext, useContext } from 'react'

/** What the chat's Find bar searches for while it's open; '' when closed. Rows that keep text out of
 *  the DOM while folded read it to open on a match, so find can see and step to that text. */
export const NativeChatFindQueryContext = createContext('')

export function useNativeChatFindQuery(): string {
  return useContext(NativeChatFindQueryContext)
}

/** Case-insensitive, as the Find bar matches. */
export function nativeChatFindHits(text: string, query: string): boolean {
  return query.length > 0 && text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}
