import React from 'react'

// A card's reference peeks report open/close here so its details hover stays shut meanwhile.
export const WorktreeCardReferencePeekContext = React.createContext<
  ((open: boolean) => void) | null
>(null)
