import { createContext } from 'react'

/** Where a card's lookup stands for its retry key: failed (with its retry), retrying, or neither. */
export type LinkPeekRetryState =
  | { status: 'failed'; retry: () => void }
  | { status: 'retrying' }
  | { status: 'idle' }

/** A card's opt-in retry key: the GitHub body reports its lookup's retry state, and the link it
 *  previews acts on that key. Null outside such a card. */
export type LinkPeekRetry = {
  /** Lowercase, as `KeyboardEvent.key` gives it without Shift. */
  key: string
  report: (state: LinkPeekRetryState) => void
}

export const LinkPeekRetryContext = createContext<LinkPeekRetry | null>(null)
