import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import {
  isNativeChatSetupFailureKind,
  nativeChatSetupAction,
  useNativeChatHostSetupView
} from './native-chat-host-setup'
import { useTranslate } from '../../../i18n/use-translate'

export function NativeChatSetupButton({
  failureKind,
  label
}: {
  failureKind: string | undefined
  /** Words for the button in place of the default (e.g. "Open terminal to sign in"). */
  label?: string
}): React.JSX.Element | null {
  return isNativeChatSetupFailureKind(failureKind) ? (
    <EligibleNativeChatSetupButton failureKind={failureKind} label={label} />
  ) : null
}

function EligibleNativeChatSetupButton({
  failureKind,
  label
}: {
  failureKind: string | undefined
  label?: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const action = nativeChatSetupAction(failureKind, useNativeChatHostSetupView(), t)
  return action ? (
    <NativeChatActionButton primary disabled={action.disabled} onClick={action.onClick}>
      {label && !action.disabled ? label : action.label}
    </NativeChatActionButton>
  ) : null
}
