import { createContext } from 'react'

/** Row-level action for handing off a chat through a specific finished response. */
export type NativeChatHandOffRowAction = {
  openFromResponse: (messageId: string) => void
}

/** Pane-level hand-off surface exposed to transcript rows when native Fork is absent. */
export type NativeChatHandOffSurface = NativeChatHandOffRowAction & {
  contextFloorSequence: number
  /** Stable across message updates so unchanged rows keep their memoized props. */
  rowAction: NativeChatHandOffRowAction
}

/** Hand-off action offered on finished responses that have no native Fork button. */
export const NativeChatHandOffContext = createContext<NativeChatHandOffSurface | undefined>(
  undefined
)
