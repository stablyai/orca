import { Button } from '@/components/ui/button'
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
  const signIn = useNativeChatSignInView()
  return signIn && isNativeChatSignInFailureKind(failureKind, signIn) ? (
    <Button
      type="button"
      variant="outline"
      size="xs"
      disabled={signIn.signingIn}
      onClick={signIn.signIn}
    >
      {nativeChatSignInLabel(signIn)}
    </Button>
  ) : null
}
