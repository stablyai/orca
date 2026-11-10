import { LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate } from '@/i18n/use-translate'
import { signInAgainActionLabel, signInAgainMessage } from '@/lib/orca-cloud/orca-sign-in-again'

/** The "Sign in" action for a neutral expired-session InlineError (pass it as `action`). */
export function SignInAgainButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button type="button" variant="outline" size="xs" onClick={onClick}>
      <LogIn aria-hidden />
      {signInAgainActionLabel(t)}
    </Button>
  )
}

/**
 * An expired Orca session. It is a soft state (nothing failed or was lost), so it renders as a
 * neutral status, not an alert, with the shared sentence and a Sign in action.
 */
export function SignInAgainNotice({
  onSignIn,
  className
}: {
  onSignIn: () => void
  className?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <InlineError
      className={className}
      tone="neutral"
      title={signInAgainMessage(t)}
      action={<SignInAgainButton onClick={onSignIn} />}
    />
  )
}
