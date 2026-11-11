import { openNativeChatAccountUsageModal } from '@/components/native-chat/usage/native-chat-account-usage-modal'
import { useMemo, type Dispatch, type SetStateAction } from 'react'
import { dispatchStructuredAgentSessionComposerCommand } from '../../../../../../shared/agent-session/view/structured-agent-session-composer'
import { localizeStructuredComposerOutcome } from '@/components/native-chat/composer/submit/structured-composer-command-error-text'
import { useStructuredAgentAcceptsImages } from '@/runtime/native-chat/agent-catalogs/use-host-structured-agent'
import type { NativeChatOptionPickerRequest } from '@/components/native-chat/session/options/controls/native-chat-option-picker-request'
import type { NativeChatStructuredComposerTransport } from '@/components/native-chat/composer/submit/native-chat-structured-composer-transport'
import type { NativeChatStructuredViewProps } from '@/components/native-chat/native-chat-view-types'
import type { useStructuredAgentSession } from '@/components/native-chat/session/structured/use-structured-agent-session'
import type {
  NativeChatPaneFork,
  NativeChatPaneForks
} from '@/components/native-chat/messages/actions/use-native-chat-fork'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentSessionThreadGoalChange } from '../../../../../../shared/agent-session/agent-session-thread-goal-wire'
import { translate } from '@/i18n/i18n'
import { useNativeChatShellHost } from '../../shell/use-native-chat-shell-host'
import type { Translate } from '@/i18n/use-translate'
import { structuredAgentLabel } from '@/lib/agent-session/launch/structured-agent-session-launch-label'

function nativeChatSessionAttachmentNotReadyNotice(
  agent: AgentType,
  starting: boolean,
  t: Translate = translate
): string {
  const label = structuredAgentLabel(agent)
  return starting
    ? t(
        'components.native-chat.composer.sessionAttachmentsStarting',
        '{{agent}} chat is still opening. Wait for it to open, then attach the files again.',
        { agent: label }
      )
    : t(
        'components.native-chat.composer.sessionAttachmentsFailed',
        '{{agent}} chat could not open. Use Retry in the chat, then attach the files again.',
        { agent: label }
      )
}

function nativeChatForkCommand(
  fork: NativeChatPaneFork | undefined,
  isWorking: boolean
): NativeChatStructuredComposerTransport['fork'] {
  // Offered once the host and agent confirm they can fork, as the response action is enabled.
  if (fork?.support.kind !== 'known') {
    return undefined
  }
  return {
    run: () => {
      if (isWorking) {
        return translate(
          'components.native-chat.fork.commandWorking',
          'Wait for the response to finish, then fork.'
        )
      }
      const outcome = fork.forkLatest()
      return outcome === 'none'
        ? translate(
            'components.native-chat.fork.commandNothing',
            'There’s no response to fork yet.'
          )
        : outcome === 'pending'
          ? translate('components.native-chat.fork.pending', 'Forking this chat…')
          : null
    }
  }
}

export function useNativeChatStructuredComposerTransport(args: {
  props: Pick<NativeChatStructuredViewProps, 'agent' | 'sessionId' | 'tabId' | 'target'>
  controller: ReturnType<typeof useStructuredAgentSession>
  /** The session's fork, run by `/fork` and `/btw`. */
  forks: NativeChatPaneForks
  /** Sends now, restarts a failed start with the message, or refuses while the chat starts. */
  sendThroughLaunch: (
    text: string,
    requiresSession: boolean,
    send: () => boolean | 'queued'
  ) => boolean | 'queued'
  starting: boolean
  transportEnabled: boolean
  worktreeId: string | undefined
  optionPickerRequest: NativeChatOptionPickerRequest | null
  setOptionPickerRequest: Dispatch<SetStateAction<NativeChatOptionPickerRequest | null>>
  onError: NativeChatStructuredComposerTransport['onError']
  reveal: { revealLatest: () => void; captureRevealLatest: () => () => void }
  /** Host reason for refusing turns and holding Send. */
  sendBlockedReason?: string | null
}): NativeChatStructuredComposerTransport {
  const { props, controller, forks, sendThroughLaunch, starting, worktreeId, optionPickerRequest } =
    args
  const { setOptionPickerRequest, onError } = args
  const { revealLatest: onSubmitted, captureRevealLatest: captureAdmittedReveal } = args.reveal
  const { transportEnabled } = args
  const sendBlockedReason = args.sendBlockedReason ?? null
  const acceptsImages = useStructuredAgentAcceptsImages(
    props.target,
    props.agent,
    controller.acceptsImages
  )
  const { fork, sideChat } = forks
  const shell = useNativeChatShellHost({
    target: props.target,
    sessionId: props.sessionId,
    isWorking: controller.isWorking,
    messages: controller.messages
  })
  return useMemo((): NativeChatStructuredComposerTransport => {
    const threadGoal = controller.threadGoal
    // A held host takes no turn; pausing or clearing a goal starts none.
    const changeThreadGoal = threadGoal?.hostChanges
      ? (change: AgentSessionThreadGoalChange) =>
          sendBlockedReason === null ||
          change.kind === 'clear' ||
          (change.kind === 'status' && change.status === 'paused')
            ? threadGoal.change(change)
            : Promise.resolve(false)
      : null
    return {
      accountUsage:
        controller.accountUsage === true
          ? {
              open: () =>
                openNativeChatAccountUsageModal({
                  sessionId: props.sessionId,
                  target: props.target
                })
            }
          : undefined,
      fork: nativeChatForkCommand(fork, controller.isWorking),
      capturePresentation: controller.capturePresentation,
      ...(sideChat ? { sideChat } : {}),
      send: (text, attachments, ...request) => {
        if (sendBlockedReason !== null) {
          return false
        }
        const requiresSession =
          attachments.length > 0 ||
          request[0]?.prepareAttachments !== undefined ||
          Boolean(request[0]?.skills?.length)
        if (starting && requiresSession) {
          onError(nativeChatSessionAttachmentNotReadyNotice(props.agent, true))
          return false
        }
        return sendThroughLaunch(text, requiresSession, () =>
          controller.send(
            text,
            attachments.map(({ path, connectionId }) => ({
              path,
              previewUri: path,
              ...(connectionId ? { connectionId } : {})
            })),
            ...request
          )
        )
      },
      dispatchCommand: (text: string, onSent?: () => void) =>
        dispatchStructuredAgentSessionComposerCommand(
          text,
          {
            agent: props.agent,
            snapshot: controller.optionSnapshot,
            invokeAction: async (id) => {
              setOptionPickerRequest({ id, consume: () => setOptionPickerRequest(null) })
              return true
            },
            setOption: controller.setStructuredOption,
            sessionCommands: controller.sessionCommands,
            conversationCommands: controller.conversationCommands,
            compactInstructions: controller.compactInstructions,
            runConversationCommand: controller.runConversationCommand,
            ...(changeThreadGoal ? { changeThreadGoal } : {})
          },
          onSent
        ).then(localizeStructuredComposerOutcome),
      ...shell,
      ...(changeThreadGoal
        ? {
            threadGoal: {
              setObjective: (objective: string) => changeThreadGoal({ kind: 'set', objective })
            }
          }
        : {}),
      sendOut: controller.sendOut,
      sendFollowUp: controller.sendFollowUp,
      ...(sendBlockedReason !== null ? { sendBlockedReason } : {}),
      optionsSurface: controller.optionSurface,
      conversationCommands: controller.conversationCommands,
      compactInstructions: controller.compactInstructions,
      optionSnapshot: controller.optionSnapshot,
      optionPickerRequest,
      sessionCommands: controller.sessionCommands,
      refreshCommands: controller.refreshCommands,
      setCommandsMenuOpen: controller.setCommandsMenuOpen,
      commandsChecking: controller.commandsChecking,
      acceptsImages,
      contextUsage: controller.contextUsage,
      worktreeId,
      onError,
      onSubmitted,
      captureAdmittedReveal,
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
    fork,
    sideChat,
    worktreeId,
    onError,
    onSubmitted,
    captureAdmittedReveal,
    optionPickerRequest,
    props.agent,
    props.sessionId,
    props.target,
    sendBlockedReason,
    sendThroughLaunch,
    setOptionPickerRequest,
    shell,
    starting,
    transportEnabled
  ])
}
