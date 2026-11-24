import { NativeChatTextAttachmentScope } from '../media/text/NativeChatTextAttachments'
import { forwardRef } from 'react'
import { PipelineSessionControls } from '@/components/pipelines/PipelineSessionControls'
import { useNativeChatTabOwnerWorktreeId } from '../pane/ownership/use-native-chat-tab-owner'
import { NativeChatComposerPane } from './NativeChatComposerPane'
import type {
  NativeChatComposerHandle,
  NativeChatComposerProps
} from './native-chat-composer-types'

export const NativeChatComposer = forwardRef<NativeChatComposerHandle, NativeChatComposerProps>(
  function NativeChatComposer(props, ref): React.JSX.Element {
    const worktreeId = useNativeChatTabOwnerWorktreeId(props.terminalTabId)
    return (
      <NativeChatTextAttachmentScope
        key={props.paneKey}
        enabled={Boolean(props.structuredTransport)}
      >
        {!props.editSession && !props.launchPrompt && !props.workspacePending && (
          <PipelineSessionControls
            worktreeId={worktreeId}
            sessionBinding={
              props.structuredTransport
                ? { sessionId: props.structuredTransport.sessionId }
                : { paneKey: props.paneKey }
            }
          />
        )}
        <NativeChatComposerPane {...props} ref={ref} />
      </NativeChatTextAttachmentScope>
    )
  }
)
