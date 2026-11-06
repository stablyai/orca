import { Button } from '@/components/ui/button'
import { nativeChatSignInLabel, useNativeChatSignInView } from './native-chat-sign-in'

export function NativeChatSignInButton(): React.JSX.Element | null {
  const signIn = useNativeChatSignInView()
  return signIn ? (
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
