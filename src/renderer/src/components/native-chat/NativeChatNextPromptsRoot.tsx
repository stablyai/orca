import type { ComponentPropsWithRef } from 'react'
import { latestNativeChatNextPrompts } from '../../../../shared/native-chat-next-prompts'
import {
  NativeChatNextPromptsContext,
  NativeChatNextPromptsEnabledContext
} from './native-chat-next-prompts-context'
import type { useStructuredAgentSession } from './use-structured-agent-session'

type NextPromptsRootProps = ComponentPropsWithRef<'div'> & {
  agent: string
  online: boolean
  controller: Pick<
    ReturnType<typeof useStructuredAgentSession>,
    'status' | 'messages' | 'prompts' | 'queuedMessages' | 'journalItems' | 'latestTurn'
  >
}

export function NativeChatNextPromptsRoot({
  agent,
  online,
  controller,
  ...props
}: NextPromptsRootProps): React.JSX.Element {
  const enabled = agent === 'codex'
  const prompts =
    enabled &&
    online &&
    controller.status === 'ready' &&
    controller.prompts.length === 0 &&
    controller.queuedMessages.cards.length === 0
      ? latestNativeChatNextPrompts(
          controller.messages,
          controller.journalItems,
          controller.latestTurn
        )
      : []
  return (
    <NativeChatNextPromptsEnabledContext value={enabled}>
      <NativeChatNextPromptsContext value={prompts}>
        <div {...props} />
      </NativeChatNextPromptsContext>
    </NativeChatNextPromptsEnabledContext>
  )
}
