import { NativeChatTextAttachmentScope } from './NativeChatTextAttachments'
import { forwardRef } from 'react'
import { NativeChatComposerPane } from './NativeChatComposerPane'
import { NativeChatComposerWorkspace } from './NativeChatComposerWorkspace'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'
export type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    return (
      <NativeChatTextAttachmentScope
        key={props.paneKey}
        enabled={Boolean(props.structuredTransport)}
      >
        <NativeChatComposerPane {...props} ref={ref} />
        {!props.editSession && (
          <NativeChatComposerWorkspace
            terminalTabId={props.terminalTabId}
            structuredTransport={props.structuredTransport}
          />
        )}
      </NativeChatTextAttachmentScope>
    )
  }
)
