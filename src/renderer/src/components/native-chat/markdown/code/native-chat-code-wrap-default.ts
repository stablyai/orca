import { createContext } from 'react'

/** The transcript-wide wrap default for code fences; the per-block toggle still wins. False outside a transcript. */
export const NativeChatCodeWrapDefaultContext = createContext<boolean>(false)
