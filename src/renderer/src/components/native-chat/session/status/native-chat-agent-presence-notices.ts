import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { AgentType } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import { formatAgentTypeLabel } from '../../../../../../shared/agent-status/presentation/agent-type-label'
import {
  isNativeChatRestartNewConversation,
  nativeChatAgentExitWording,
  type NativeChatAgentExit,
  type NativeChatAgentPresence
} from '../../../../../../shared/native-chat/agent-presence/native-chat-agent-presence'
import type { NativeChatComposerNotice } from '../../composer/controls/native-chat-composer-notice'

/** The composer's status line for an agent that exited or came back in this terminal. */
export function nativeChatAgentPresenceNotices(args: {
  presence: NativeChatAgentPresence
  agent: AgentType
  sessionId: string | null
  onShowTerminal?: () => void
  onDismissRestart: () => void
  t?: Translate
}): NativeChatComposerNotice[] {
  const t = args.t ?? translate
  const agent = formatAgentTypeLabel(args.agent)
  if (args.presence.exit) {
    return [
      {
        key: 'agent-exited',
        kind: 'host',
        tone: 'warning',
        text: nativeChatAgentExitText(args.presence.exit, agent, t),
        ...(args.onShowTerminal
          ? {
              action: {
                label: t('components.native-chat.toggle.showTerminal', 'Show terminal'),
                onClick: args.onShowTerminal,
                primary: true
              }
            }
          : {})
      }
    ]
  }
  if (!args.presence.restartFrom) {
    return []
  }
  return [
    {
      key: 'agent-restarted',
      kind: 'host',
      tone: 'muted',
      text: isNativeChatRestartNewConversation(args.presence.restartFrom, args.sessionId)
        ? t(
            'components.native-chat.agentPresence.restartedNewSession',
            '{{agent}} restarted in a new session. Earlier messages are not part of its context.',
            { agent }
          )
        : t('components.native-chat.agentPresence.runningAgain', '{{agent}} is running again.', {
            agent
          }),
      onDismiss: args.onDismissRestart
    }
  ]
}

function nativeChatAgentExitText(exit: NativeChatAgentExit, agent: string, t: Translate): string {
  const wording = nativeChatAgentExitWording(exit.exitCode)
  switch (wording.kind) {
    case 'killed':
      return t(
        'components.native-chat.agentPresence.killed',
        '{{agent}} was killed (exit {{code}}, often out of memory). Sending is paused so nothing is typed into the shell.',
        { agent, code: wording.code }
      )
    case 'signal':
      return t(
        'components.native-chat.agentPresence.stoppedBySignal',
        '{{agent}} was stopped by {{signal}} (exit {{code}}). Sending is paused so nothing is typed into the shell.',
        { agent, signal: wording.signal, code: wording.code }
      )
    case 'code':
      return t(
        'components.native-chat.agentPresence.exitedWithCode',
        '{{agent}} exited (exit {{code}}). Sending is paused so nothing is typed into the shell.',
        { agent, code: wording.code }
      )
    case 'plain':
      return t(
        'components.native-chat.agentPresence.exited',
        '{{agent}} is no longer running in this terminal. Sending is paused so nothing is typed into the shell.',
        { agent }
      )
  }
}
