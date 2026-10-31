import {
  AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION,
  AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION
} from '../../../../shared/agent-session-account-switch-row'
import type { NativeChatTextBlock } from '../../../../shared/native-chat-types'
import { translate } from '@/i18n/i18n'

export function isNativeChatAccountSwitchLine(block: NativeChatTextBlock): boolean {
  return (
    block.presentation === AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION ||
    block.presentation === AGENT_SESSION_ACCOUNT_SWITCH_FAILED_PRESENTATION
  )
}

function accountName(account: string | null | undefined): string {
  return account ?? translate('accounts.claude.systemDefault', 'System default')
}

function accountSwitchWords(block: NativeChatTextBlock): string {
  const switched = block.accountSwitch
  const account = accountName(switched?.account)
  if (block.presentation === AGENT_SESSION_ACCOUNT_SWITCH_PRESENTATION) {
    return translate(
      'components.native-chat.notices.accountSwitched',
      'Now on {{account}} · same conversation',
      { account }
    )
  }
  return switched?.from === undefined
    ? translate(
        'components.native-chat.notices.accountSwitchFailed',
        "Couldn't move this chat to {{account}}; it stays on its current account",
        { account }
      )
    : translate(
        'components.native-chat.notices.accountSwitchFailedFrom',
        "Couldn't move this chat to {{account}}; it's still on {{from}}",
        { account, from: accountName(switched.from) }
      )
}

/** The quiet line saying the chat moved to the picker's account, or could not. */
export function NativeChatAccountSwitchLine({
  block
}: {
  block: NativeChatTextBlock
}): React.JSX.Element {
  return (
    <p className="min-w-0 max-w-full select-text text-sm text-chat-foreground-faint [overflow-wrap:anywhere]">
      {accountSwitchWords(block)}
    </p>
  )
}
