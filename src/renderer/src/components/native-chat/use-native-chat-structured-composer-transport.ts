import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { useStructuredAgentAcceptsImages } from '@/runtime/use-host-structured-agent'
import type {
  NativeChatOptionPickerRequest,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { StructuredAgentSessionQueuedMessagesController } from './use-structured-agent-session-queued-messages'

/** What the composer of a structured chat sends, picks and runs through, from the chat's controller. */
export function useNativeChatStructuredComposerTransport(args: {
  props: Pick<NativeChatStructuredViewProps, 'agent' | 'sessionId' | 'target'>
  controller: ReturnType<typeof useStructuredAgentSession>
  sendThroughRelaunch: (send: () => boolean) => boolean
  worktreeId: string | undefined
  optionPickerRequest: NativeChatOptionPickerRequest | null
  setOptionPickerRequest: Dispatch<SetStateAction<NativeChatOptionPickerRequest | null>>
  onError: NativeChatStructuredComposerTransport['onError']
  onSubmitted: () => void
  queuedMessages: Pick<StructuredAgentSessionQueuedMessagesController, 'queueHold' | 'queueResume'>
}): NativeChatStructuredComposerTransport {
  const { props, controller, sendThroughRelaunch, worktreeId, optionPickerRequest } = args
  const { setOptionPickerRequest, onError, onSubmitted, queuedMessages } = args
  const acceptsImages = useStructuredAgentAcceptsImages(props.target, props.agent)
  return useMemo((): NativeChatStructuredComposerTransport => {
    const threadGoal = controller.threadGoal
    const setThreadGoalObjective = threadGoal
      ? (objective: string) => threadGoal.change({ kind: 'set', objective })
      : null
    return {
      send: (text, attachments) => {
        let admission: boolean | 'queued' = false
        const accepted = sendThroughRelaunch(() => {
          admission = controller.send(
            text,
            attachments.map((attachment) => ({
              path: attachment.path,
              previewUri: attachment.path
            }))
          )
          return admission !== false
        })
        return accepted ? admission : false
      },
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: props.agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async (id) => {
            setOptionPickerRequest((current) => ({ id, sequence: (current?.sequence ?? 0) + 1 }))
            return true
          },
          setOption: controller.setStructuredOption,
          conversationCommands: controller.conversationCommands,
          runConversationCommand: controller.runConversationCommand,
          ...(setThreadGoalObjective ? { setThreadGoalObjective } : {})
        }),
      ...(setThreadGoalObjective ? { threadGoal: { setObjective: setThreadGoalObjective } } : {}),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      acceptsImages,
      contextUsage: controller.contextUsage,
      worktreeId,
      onError,
      onSubmitted,
      runtime: props.target.kind === 'local' ? 'local' : 'remote',
      sessionId: props.sessionId,
      runtimeEnvironmentId:
        props.target.kind === 'local' ? null : (props.target.environmentId ?? null),
      queueHold: queuedMessages.queueHold,
      queueResume: queuedMessages.queueResume
    }
  }, [
    acceptsImages,
    controller,
    worktreeId,
    onError,
    onSubmitted,
    optionPickerRequest,
    props.agent,
    props.sessionId,
    props.target,
    queuedMessages,
    sendThroughRelaunch,
    setOptionPickerRequest
  ])
}
