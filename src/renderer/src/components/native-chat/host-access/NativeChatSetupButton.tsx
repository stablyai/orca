import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import {
  isNativeChatSetupFailureKind,
  nativeChatSetupAction,
  useNativeChatHostSetupView
} from './native-chat-host-setup'
import { useTranslate } from '../../../i18n/use-translate'

export function NativeChatSetupButton({
  failureKind
}: {
  failureKind: string | undefined
}): React.JSX.Element | null {
  return isNativeChatSetupFailureKind(failureKind) ? (
    <EligibleNativeChatSetupButton failureKind={failureKind} />
  ) : null
}

function EligibleNativeChatSetupButton({
  failureKind
}: {
  failureKind: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const action = nativeChatSetupAction(failureKind, useNativeChatHostSetupView(), t)
  return action ? (
    <NativeChatActionButton primary disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </NativeChatActionButton>
  ) : null
}
