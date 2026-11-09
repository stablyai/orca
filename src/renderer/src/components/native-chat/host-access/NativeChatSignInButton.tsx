import { NativeChatActionButton } from '../composer/controls/NativeChatActionButton'
import {
  isNativeChatSignInFailureKind,
  nativeChatSignInLabel,
  useNativeChatSignInView
} from './native-chat-sign-in'
import { useTranslate } from '../../../i18n/use-translate'

export function NativeChatSignInButton({
  failureKind
}: {
  failureKind: string | undefined
}): React.JSX.Element | null {
  return failureKind === 'modelNotSelected' || isNativeChatSignInFailureKind(failureKind) ? (
    <EligibleNativeChatSignInButton failureKind={failureKind} />
  ) : null
}

function EligibleNativeChatSignInButton({
  failureKind
}: {
  failureKind: string | undefined
}): React.JSX.Element | null {
  const t = useTranslate()
  const signIn = useNativeChatSignInView()
  return signIn && isNativeChatSignInFailureKind(failureKind, signIn) ? (
    <NativeChatActionButton primary disabled={signIn.signingIn} onClick={signIn.signIn}>
      {nativeChatSignInLabel(signIn, t)}
    </NativeChatActionButton>
  ) : null
}
