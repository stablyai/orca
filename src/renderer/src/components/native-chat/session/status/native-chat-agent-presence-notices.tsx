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
import { NativeChatActionButton } from '../../composer/controls/NativeChatActionButton'
import type { NativeChatAgentRestart } from './use-native-chat-agent-restart'
import { nativeChatAgentRestartFailureText } from './native-chat-agent-restart-copy'

/** The composer's status line for an agent that exited or came back in this terminal. */
export function nativeChatAgentPresenceNotices(args: {
  presence: NativeChatAgentPresence
  agent: AgentType
  sessionId: string | null
  onShowTerminal?: () => void
  onDismissRestart: () => void
  restart?: NativeChatAgentRestart
  t?: Translate
}): NativeChatComposerNotice[] {
  const t = args.t ?? translate
  const agent = formatAgentTypeLabel(args.agent)
  const phase = args.restart?.phase ?? { kind: 'idle' }
  const failure =
    phase.kind === 'failed' ? nativeChatAgentRestartFailureText(phase.reason, agent, t) : null
  if (args.presence.exit) {
    const restarting = phase.kind === 'restarting'
    const text = restarting
      ? phase.mode === 'resume'
        ? t('components.native-chat.agentPresence.resuming', 'Resuming {{agent}}…', { agent })
        : t('components.native-chat.agentPresence.starting', 'Starting a new {{agent}} session…', {
            agent
          })
      : (failure ?? nativeChatAgentExitText(args.presence.exit, agent, t))
    return [
      {
        key: 'agent-exited',
        kind: 'host',
        tone: 'warning',
        text,
        ...exitActions(args.restart, restarting, args.onShowTerminal, t)
      }
    ]
  }
  if (!args.presence.restartFrom) {
    return []
  }
  const newConversation = isNativeChatRestartNewConversation(
    args.presence.restartFrom,
    args.sessionId
  )
  const restart = args.restart
  return [
    {
      key: 'agent-restarted',
      kind: 'host',
      tone: 'muted',
      text:
        failure ??
        (newConversation
          ? t(
              'components.native-chat.agentPresence.restartedNewSession',
              '{{agent}} restarted in a new session. Earlier messages are not part of its context.',
              { agent }
            )
          : t('components.native-chat.agentPresence.runningAgain', '{{agent}} is running again.', {
              agent
            })),
      ...(newConversation && restart?.canResume
        ? {
            action: {
              label: t(
                'components.native-chat.agentPresence.resumePreviousSession',
                'Resume previous session'
              ),
              onClick: () => restart.restart('resume')
            }
          }
        : {}),
      onDismiss: args.onDismissRestart
    }
  ]
}

function exitActions(
  restart: NativeChatAgentRestart | undefined,
  restarting: boolean,
  onShowTerminal: (() => void) | undefined,
  t: Translate
): Pick<NativeChatComposerNotice, 'action'> {
  const showTerminal = onShowTerminal ? (
    <NativeChatActionButton
      label={t('components.native-chat.toggle.showTerminal', 'Show terminal')}
      onClick={onShowTerminal}
    />
  ) : null
  if (!restart) {
    return onShowTerminal
      ? {
          action: {
            label: t('components.native-chat.toggle.showTerminal', 'Show terminal'),
            onClick: onShowTerminal,
            primary: true
          }
        }
      : {}
  }
  const resumeLabel = t('components.native-chat.agentPresence.resumeSession', 'Resume session')
  const freshLabel = t('components.native-chat.agentPresence.startNewSession', 'Start new session')
  const primaryMode = restart.canResume ? 'resume' : 'fresh'
  return {
    action: {
      label: primaryMode === 'resume' ? resumeLabel : freshLabel,
      onClick: () => restart.restart(primaryMode),
      primary: true,
      disabled: restarting,
      status: (
        <>
          {restart.canResume ? (
            <NativeChatActionButton
              label={freshLabel}
              disabled={restarting}
              onClick={() => restart.restart('fresh')}
            />
          ) : null}
          {showTerminal}
        </>
      )
    }
  }
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
