import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../shared/structured-agent-session-composer'
import { useStructuredAgentAcceptsImages } from '@/runtime/use-host-structured-agent'
import type {
  NativeChatOptionPickerRequest,
  NativeChatStructuredComposerTransport
} from './native-chat-composer-types'
import type { NativeChatStructuredViewProps } from './native-chat-view-types'
import type { useStructuredAgentSession } from './use-structured-agent-session'
import type { AgentType } from '../../../../shared/agent-status-types'
import { translate } from '@/i18n/i18n'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'

function nativeChatSessionAttachmentNotReadyNotice(agent: AgentType, starting: boolean): string {
  const label = structuredAgentLabel(agent)
  return starting
    ? translate(
        'components.native-chat.composer.sessionAttachmentsStarting',
        '{{agent}} chat is still opening. Wait for it to open, then attach the files again.',
        { agent: label }
      )
    : translate(
        'components.native-chat.composer.sessionAttachmentsFailed',
        '{{agent}} chat could not open. Use Retry in the chat, then attach the files again.',
        { agent: label }
      )
}

export function useNativeChatStructuredComposerTransport(args: {
  props: Pick<NativeChatStructuredViewProps, 'agent' | 'sessionId' | 'target'>
  controller: ReturnType<typeof useStructuredAgentSession>
  /** Sends now, restarts a failed start with the message, or refuses while the chat starts. */
  sendThroughLaunch: (
    text: string,
    withImages: boolean,
    send: () => boolean | 'queued'
  ) => boolean | 'queued'
  starting: boolean
  transportEnabled: boolean
  worktreeId: string | undefined
  optionPickerRequest: NativeChatOptionPickerRequest | null
  setOptionPickerRequest: Dispatch<SetStateAction<NativeChatOptionPickerRequest | null>>
  onError: NativeChatStructuredComposerTransport['onError']
  onSubmitted: () => void
  /** Host reason for refusing turns and holding Send. */
  sendBlockedReason?: string | null
}): NativeChatStructuredComposerTransport {
  const { props, controller, sendThroughLaunch, starting, worktreeId, optionPickerRequest } = args
  const { setOptionPickerRequest, onError, onSubmitted } = args
  const { transportEnabled } = args
  const sendBlockedReason = args.sendBlockedReason ?? null
  const acceptsImages = useStructuredAgentAcceptsImages(
    props.target,
    props.agent,
    controller.acceptsImages
  )
  return useMemo((): NativeChatStructuredComposerTransport => {
    const threadGoal = controller.threadGoal
    const setThreadGoalObjective = threadGoal?.hostChanges
      ? (objective: string) =>
          sendBlockedReason === null
            ? threadGoal.change({ kind: 'set', objective })
            : Promise.resolve(false)
      : null
    return {
      capturePresentation: controller.capturePresentation,
      send: (text, attachments, ...request) =>
        sendBlockedReason === null &&
        sendThroughLaunch(text, attachments.length > 0, () =>
          controller.send(
            text,
            attachments.map(({ path, connectionId }) => ({
              path,
              previewUri: path,
              ...(connectionId ? { connectionId } : {})
            })),
            ...request
          )
        ),
      dispatchCommand: (text: string) =>
        dispatchStructuredAgentSessionComposerCommand(text, {
          agent: props.agent,
          snapshot: controller.optionSnapshot,
          invokeAction: async (id) => {
            setOptionPickerRequest({ id, consume: () => setOptionPickerRequest(null) })
            return true
          },
          setOption: controller.setStructuredOption,
          conversationCommands: controller.conversationCommands,
          runConversationCommand: controller.runConversationCommand,
          ...(setThreadGoalObjective ? { setThreadGoalObjective } : {})
        }),
      ...(setThreadGoalObjective ? { threadGoal: { setObjective: setThreadGoalObjective } } : {}),
      sendOut: controller.sendOut || starting,
      ...(sendBlockedReason !== null ? { sendBlockedReason } : {}),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      refreshCommands: controller.refreshCommands,
      acceptsImages,
      contextUsage: controller.contextUsage,
      worktreeId,
      onError,
      onSubmitted,
      runtime: props.target.kind === 'local' ? 'local' : 'remote',
      sessionId: props.sessionId,
      runtimeEnvironmentId:
        props.target.kind === 'local' ? null : (props.target.environmentId ?? null),
      ...(!transportEnabled
        ? {
            sessionPending: true,
            sessionPendingNotice: nativeChatSessionAttachmentNotReadyNotice(props.agent, starting)
          }
        : {})
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
    sendBlockedReason,
    sendThroughLaunch,
    setOptionPickerRequest,
    starting,
    transportEnabled
  ])
}
