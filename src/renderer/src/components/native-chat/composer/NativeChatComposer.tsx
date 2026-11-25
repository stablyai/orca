import { NativeChatTextAttachmentScope } from '../media/text/NativeChatTextAttachments'
import { forwardRef } from 'react'
import {
  NativeChatPluginComposerItems,
  useNativeChatPluginComposerItems
} from './controls/use-native-chat-plugin-composer-items'
import { NativeChatComposerPane } from './NativeChatComposerPane'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    const { structuredTransport, editSession, launchPrompt } = props
    const chat =
      editSession || launchPrompt || structuredTransport?.sessionPending
        ? undefined
        : structuredTransport
    const items = useNativeChatPluginComposerItems(
      chat?.sessionId,
      props.agent,
      chat?.runtime,
      props.isWorking ?? false
    )
    return (
      <NativeChatTextAttachmentScope
        key={props.paneKey}
        enabled={Boolean(props.structuredTransport)}
      >
        <NativeChatPluginComposerItems.Provider value={items}>
          <NativeChatComposerPane {...props} ref={ref} />
        </NativeChatPluginComposerItems.Provider>
      </NativeChatTextAttachmentScope>
    )
  }
)
