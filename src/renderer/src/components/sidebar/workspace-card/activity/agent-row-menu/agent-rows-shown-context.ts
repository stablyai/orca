import { createContext } from 'react'

/**
 * False under a collapsed agent list. Collapsed rows stay mounted (inert) for the closing
 * animation, so an Agent menu opened on one of them must close itself.
 */
export const AgentRowsShownContext = createContext(true)
