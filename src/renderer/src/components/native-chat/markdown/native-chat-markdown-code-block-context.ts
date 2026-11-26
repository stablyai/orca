import { createContext } from 'react'

export const NativeChatMarkdownCodeBlockContext = createContext<{
  rowKey?: string
  growing: boolean
}>({ growing: false })
