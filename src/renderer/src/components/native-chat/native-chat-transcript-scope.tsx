import type { ReactNode } from 'react'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  NativeChatVisualOwnerContext,
  useNativeChatTabVisualOwner
} from './media/visuals/native-chat-visual-owner'
import type { NativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import {
  NativeChatMarkdownImageOwnerContext,
  useNativeChatTabMarkdownImageOwner,
  type NativeChatMarkdownImageOwner
} from './media/images/native-chat-markdown-image-owner'
import { NativeChatLinkPeekProvider } from './links/previews/native-chat-link-peek-context'
import { NativeChatFileLinkExistenceContext } from './links/actions/native-chat-file-link-existence'
import type { NativeChatFileLinkExistence } from '../../../../shared/native-chat/file-access/native-chat-file-link-existence'
import { useNativeChatTabFileLinkExistence } from './links/actions/use-native-chat-file-link-existence'

export type NativeChatTranscriptScopeValue = {
  visualOwner: NativeChatVisualOwner | null
  image: NativeChatMarkdownImageOwner
  existence: NativeChatFileLinkExistence | null
}

/** Every context a transcript's rows read. Tab chats and bot group rooms both mount this one set. */
export function NativeChatTranscriptScope({
  value,
  children
}: {
  value: NativeChatTranscriptScopeValue
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatVisualOwnerContext.Provider value={value.visualOwner}>
      <NativeChatFileLinkExistenceContext.Provider value={value.existence}>
        <NativeChatMarkdownImageOwnerContext.Provider value={value.image}>
          <NativeChatLinkPeekProvider fileLinkContext={value.image.fileLinkContext}>
            {children}
          </NativeChatLinkPeekProvider>
        </NativeChatMarkdownImageOwnerContext.Provider>
      </NativeChatFileLinkExistenceContext.Provider>
    </NativeChatVisualOwnerContext.Provider>
  )
}

/** A tab's chat: everything resolves from the tab's workspace. Bridge chats have no visual owner. */
export function NativeChatTabTranscriptScope({
  tabId,
  isVisible,
  sessionId,
  target,
  children
}: {
  tabId: string
  isVisible: boolean
  sessionId: string | null
  target?: RuntimeClientTarget
  children: ReactNode
}): React.JSX.Element {
  const visualOwner = useNativeChatTabVisualOwner(target ?? null, sessionId, tabId)
  const existence = useNativeChatTabFileLinkExistence(tabId)
  const image = useNativeChatTabMarkdownImageOwner(tabId, isVisible, sessionId)
  return (
    <NativeChatTranscriptScope value={{ visualOwner, image, existence }}>
      {children}
    </NativeChatTranscriptScope>
  )
}
