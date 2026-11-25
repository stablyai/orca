import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import {
  isNativeChatFailureRowResolved,
  isNativeChatSetupFailureKind,
  nativeChatSetupAction,
  useNativeChatHostSetupView
} from './native-chat-host-setup-view'
import { useTranslate } from '../../../i18n/use-translate'

export function NativeChatSetupButton({
  failureKind,
  rowId
}: {
  failureKind: string | undefined
  /** The transcript row that reports the failure; a later successful turn resolved it. */
  rowId: string | undefined
}): React.JSX.Element | null {
  return isNativeChatSetupFailureKind(failureKind) ? (
    <EligibleNativeChatSetupButton failureKind={failureKind} rowId={rowId} />
  ) : null
}

function EligibleNativeChatSetupButton({
  failureKind,
  rowId
}: {
  failureKind: string | undefined
  rowId: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const setup = useNativeChatHostSetupView()
  const action = isNativeChatFailureRowResolved(setup, rowId)
    ? undefined
    : nativeChatSetupAction(failureKind, setup, t)
  return action ? (
    <NativeChatActionButton primary disabled={action.disabled} onClick={action.onClick}>
      {action.label}
    </NativeChatActionButton>
  ) : null
}
