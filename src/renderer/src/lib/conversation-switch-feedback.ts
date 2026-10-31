import { translate } from '@/i18n/i18n'
import { structuredLaunchFailure } from './structured-agent-session-launch-failure'
import { agentLabel } from '../../../shared/ai-vault-session-filters'
import type { AiVaultAgent } from '../../../shared/ai-vault-types'

export function conversationSwitchFailureText(
  error: unknown,
  args: {
    agent: AiVaultAgent
    direction: 'chat' | 'terminal'
    source?: unknown
    history?: unknown
    platform?: string
  },
  reasonOverride?: string
): string {
  const failure = structuredLaunchFailure(error)
  const reason = reasonOverride ?? failure?.details?.reason
  const values = { agent: agentLabel(args.agent) }
  if (reason === 'conversationHeldElsewhere') {
    return failure?.source
      ? translate(
          'components.tab.bar.switch.sourceExitUnconfirmed',
          'Orca could not confirm {{agent}} stopped in this terminal. Quit {{agent}} here, then try this action again.',
          values
        )
      : failure?.owner
        ? translate(
            'components.tab.bar.switch.openElsewhere',
            '{{agent}} is open in another chat or terminal. Continue there, then try switching again.',
            values
          )
        : translate(
            'components.tab.bar.switch.writerUnconfirmed',
            'Orca could not confirm {{agent}} stopped. Check its open chats and terminals, then try this action again.',
            values
          )
  }
  if (reason === 'ownerUnproven' || reason === 'previousExitUnverifiable') {
    return translate(
      args.source
        ? 'components.tab.bar.switch.sourceStopUnknown'
        : 'components.tab.bar.switch.stopUnknown',
      args.source
        ? 'Orca could not confirm {{agent}} stopped. Check {{agent}} in the original terminal, then try switching again.'
        : 'Orca could not confirm {{agent}} stopped. Check its open chats and terminals, then try switching again.',
      values
    )
  }
  if (reason === 'operationExpired' || reason === 'outcomeUnknown' || reason === 'tabUnconfirmed') {
    return translate(
      'components.tab.bar.switch.outcomeUnknown',
      'Orca could not confirm the {{agent}} switch. Check the open chat and terminal before trying again.',
      values
    )
  }
  if (reason === 'messagesUnsettled' || reason === 'handoffInFlight') {
    return translate(
      'components.tab.bar.switch.changeInProgress',
      '{{agent}} is still finishing another change to this conversation. Try again in a moment.',
      values
    )
  }
  if (reason === 'recordMissing') {
    return translate(
      'components.tab.bar.switch.conversationMissing',
      'Orca could not find this {{agent}} conversation. Open it from Session History, then try again.',
      values
    )
  }
  if (reason === 'transcriptNotFound') {
    return translate(
      'components.native-chat.resumeInNewChat.notSavedYet',
      "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
      values
    )
  }
  // From a terminal, the retry is the Switch to Chat UI its pane (or Session History) still offers.
  const fromTerminal = args.direction === 'chat' && args.source !== undefined
  if (reason === 'transcriptUnreadable') {
    return fromTerminal
      ? translate(
          'components.tab.bar.switch.historyUnavailableFromTerminal',
          "{{agent}} couldn't open this conversation's history. Check that its saved conversation is available, then use Switch to Chat UI to try again.",
          values
        )
      : translate(
          'components.tab.bar.switch.historyUnavailable',
          "{{agent}} couldn't open this conversation's history. Check that its saved conversation is available, then try again.",
          values
        )
  }
  if (fromTerminal) {
    return translate(
      'components.tab.bar.switch.chatSwitchFailedFromTerminal',
      '{{agent}} could not switch to chat. Use Switch to Chat UI to try again.',
      values
    )
  }
  return args.direction === 'chat'
    ? translate(
        'components.tab.bar.switch.chatSwitchFailed',
        '{{agent}} could not switch to chat. Try again.',
        values
      )
    : translate(
        'components.tab.bar.switch.terminalSwitchFailed',
        '{{agent}} could not switch to a terminal. Try again.',
        values
      )
}

export function conversationSwitchSourceKept(agent: AiVaultAgent): string {
  return translate(
    'components.tab.bar.switch.sourceKept',
    '{{agent}} opened successfully. The original tab was kept; continue in the new tab.',
    { agent: agentLabel(agent) }
  )
}

export function conversationSwitchUnsupportedText(agent: AiVaultAgent): string {
  return translate(
    'components.tab.bar.switch.hostCannotSwitch',
    'Orca on this host cannot switch {{agent}} in place. Update Orca there, or open a copy with Continue with Terminal Agent.',
    { agent: agentLabel(agent) }
  )
}
