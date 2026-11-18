import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import { nativeChatSetupAction, useNativeChatHostSetupView } from './native-chat-host-setup'
import { useTranslate } from '../../../i18n/use-translate'
import type { AgentJournalPosition } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  isNativeChatSetupFailureKind,
  isResolvedNativeChatSetupFailure
} from '../../../../../shared/native-chat/transcript/turns/native-chat-setup-failure-resolution'

type SetupButtonProps = {
  failureKind: string | undefined
  /** The failure row's place in the journal; a turn that succeeded since resolves it. */
  position?: AgentJournalPosition
}

export function NativeChatSetupButton(props: SetupButtonProps): React.JSX.Element | null {
  return isNativeChatSetupFailureKind(props.failureKind) ? (
    <EligibleNativeChatSetupButton {...props} />
  ) : null
}

function EligibleNativeChatSetupButton({
  failureKind,
  position
}: SetupButtonProps): React.JSX.Element | null {
  const t = useTranslate()
  const setup = useNativeChatHostSetupView()
  const action = isResolvedNativeChatSetupFailure(failureKind, position, setup?.latestSucceededTurn)
    ? undefined
    : nativeChatSetupAction(failureKind, setup, t)
  return action ? (
    <NativeChatActionButton primary disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </NativeChatActionButton>
  ) : null
}
