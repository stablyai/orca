import { NativeChatTextAttachmentScope } from '../media/text/NativeChatTextAttachments'
import { forwardRef } from 'react'
import { NativeChatComposerPane } from './NativeChatComposerPane'
import { NativeChatCrossVendorContext } from '../session/options/cross-vendor/native-chat-cross-vendor-context'
import type {
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
        <NativeChatCrossVendorContext.Provider
          value={props.structuredTransport?.crossVendor ?? null}
        >
          <NativeChatComposerPane {...props} ref={ref} />
        </NativeChatCrossVendorContext.Provider>
      </NativeChatTextAttachmentScope>
    )
  }
)
