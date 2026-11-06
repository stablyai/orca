import { NativeChatActionButton } from './NativeChatActionButton'
import {
  isNativeChatSignInFailureKind,
  nativeChatSignInLabel,
  useNativeChatSignInView
} from './native-chat-sign-in'

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
  const signIn = useNativeChatSignInView()
  return signIn && isNativeChatSignInFailureKind(failureKind, signIn) ? (
    <NativeChatActionButton primary disabled={signIn.signingIn} onClick={signIn.signIn}>
      {nativeChatSignInLabel(signIn)}
    </NativeChatActionButton>
  ) : null
}
