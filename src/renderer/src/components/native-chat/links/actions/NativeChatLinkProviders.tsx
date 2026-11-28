import type { ReactNode } from 'react'
import {
  NativeChatFileOpenContext,
  NativeChatLinkClickContext
} from './native-chat-link-click-context'
import type { NativeChatLinkActions } from './use-native-chat-link-actions'

/** A chat session's link handlers: link clicks honor link settings, explicit open buttons do not. */
export function NativeChatLinkProviders({
  links,
  children
}: {
  links: Pick<NativeChatLinkActions, 'onLinkClick' | 'openFile'>
  children: ReactNode
}): React.JSX.Element {
  return (
    <NativeChatLinkClickContext value={links.onLinkClick}>
      <NativeChatFileOpenContext value={links.openFile}>{children}</NativeChatFileOpenContext>
    </NativeChatLinkClickContext>
  )
}
