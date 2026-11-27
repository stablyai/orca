import { createContext } from 'react'

/** Agent rows here are a bot's answers where no bot owns the workspace: a group room's member
 *  turns, whose workspace is the room's home. */
export const NativeChatBotAnswerContext = createContext(false)
