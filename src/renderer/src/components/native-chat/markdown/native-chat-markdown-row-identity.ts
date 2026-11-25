import { createContext } from 'react'

/** The transcript row whose markdown is rendering, so a code block inside it can key its wrap. */
export const NativeChatMarkdownRowKeyContext = createContext<string | undefined>(undefined)
