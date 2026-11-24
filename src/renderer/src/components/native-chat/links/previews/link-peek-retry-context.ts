import { createContext } from 'react'

/** A card's opt-in retry key: the GitHub body reports its retry while its lookup has failed, and the
 *  link it previews runs it on that key. Null outside such a card. */
export type LinkPeekRetry = {
  /** Lowercase, as `KeyboardEvent.key` gives it without Shift. */
  key: string
  report: (retry: (() => void) | null) => void
}

export const LinkPeekRetryContext = createContext<LinkPeekRetry | null>(null)
