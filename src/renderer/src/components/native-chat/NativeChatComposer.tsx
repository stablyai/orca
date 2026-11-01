import { forwardRef } from 'react'
import { NativeChatComposerPane } from './NativeChatComposerPane'
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
    return <NativeChatComposerPane key={props.paneKey} {...props} ref={ref} />
  }
)
