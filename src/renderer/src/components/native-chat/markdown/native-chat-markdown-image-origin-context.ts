import { createContext } from 'react'
import type { Element } from 'hast'
import type { NativeChatDocumentImageOrigin } from './native-chat-markdown-image-origins'

export const NativeChatMarkdownImageOriginContext = createContext<WeakMap<
  Element,
  NativeChatDocumentImageOrigin
> | null>(null)
