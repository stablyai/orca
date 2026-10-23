import { createContext } from 'react'

export const NativeChatNextPromptsEnabledContext = createContext(false)
export const NativeChatNextPromptsContext = createContext<readonly string[]>([])
