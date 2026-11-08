import { useId, useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { LoadingSpinner } from '../LoadingSpinner'
import { ManagedRuntimeLinkButton } from '../managed-runtime/ManagedRuntimeLinkButton'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { AntigravityChatAuthAction } from './AntigravityChatAuthForm'
import type { AntigravityChatSignInControls } from './AntigravityChatSignInRow'

export function AntigravityChatSignInBadge({
  signIn
}: {
  signIn: AntigravityChatSignInControls
}): React.JSX.Element | null {
  const t = useTranslate()
  if (signIn.signingIn) {
    return (
      <Badge variant="dot">
        <LoadingSpinner className="size-3 text-muted-foreground" />
        {t('accounts.antigravity.chatBadgeSigningIn', 'Signing in')}
      </Badge>
    )
  }
  if (signIn.auth === 'signedIn') {
    return (
      <Badge variant="dot">
        <span aria-hidden className="size-1.5 rounded-full bg-status-success" />
        {t('accounts.antigravity.chatBadgeSignedIn', 'Signed in')}
      </Badge>
    )
  }
  if (signIn.auth === 'signedOut') {
    return (
      <Badge variant="dot">
        <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />
        {t('accounts.antigravity.chatBadgeSignedOut', 'Not signed in')}
      </Badge>
    )
  }
  return null
}

// A cancelled or failed switch leaves the host signed in, so it still offers a change, not a first sign-in.
const changingAccount = (signIn: AntigravityChatSignInControls, auth: AntigravityChatAuthAction) =>
  signIn.auth === 'signedIn' && !auth.reauth

function actionLabel(
  signIn: AntigravityChatSignInControls,
  auth: AntigravityChatAuthAction,
  t: Translate = translate
) {
  if (changingAccount(signIn, auth)) {
    return t('accounts.antigravity.chatChangeAccount', 'Change account')
  }
  if (auth.method && !auth.recovering) {
    return t('accounts.antigravity.chatSignInWith', 'Sign in with {{method}}', {
      method: auth.method
    })
  }
  return signIn.action === 'retry'
    ? t('accounts.antigravity.chatRetry', 'Retry sign-in')
    : t('accounts.antigravity.chatSignIn', 'Sign in')
}

/** One status line and one full-size action; a running sign-in swaps in its own panel. */
export function AntigravityChatSignInAction({
  signIn,
  auth,
  size
}: {
  signIn: AntigravityChatSignInControls
  auth: AntigravityChatAuthAction
  size: 'default' | 'sm'
}): React.JSX.Element {
  const t = useTranslate()
  const alert = auth.alert ? (
    <span role="alert" className="flex items-center gap-1.5 text-destructive">
      <AlertCircle className="size-3.5 shrink-0" />
      {auth.alert}
    </span>
  ) : null
  if (signIn.ownFlow) {
    return <SignInFlowPanel signIn={signIn} alert={alert} />
  }
  const message =
    signIn.line ??
    (auth.incomplete
      ? t(
          'accounts.antigravity.enterpriseFieldsNeeded',
          'Enter a Google Cloud project and location.'
        )
      : null) ??
    (auth.reauth && auth.method
      ? t('accounts.antigravity.chatSwitchMethod', 'Sign in again to switch to {{method}}.', {
          method: auth.method
        })
      : null)
  const secondary = changingAccount(signIn, auth)
  // The badge is not announced, so the live region carries the settled result too.
  const settled =
    signIn.auth === 'signedIn'
      ? t('accounts.antigravity.chatBadgeSignedIn', 'Signed in')
      : signIn.auth === 'signedOut'
        ? t('accounts.antigravity.chatBadgeSignedOut', 'Not signed in')
        : null
  return (
    <div className="flex flex-wrap items-center justify-end gap-3">
      <div role="status" className="min-w-0 flex-1 basis-40 text-xs text-muted-foreground">
        {alert ?? message ?? (settled && <span className="sr-only">{settled}</span>)}
      </div>
      <Button
        size={size}
        variant={secondary ? 'outline' : 'default'}
        disabled={
          (auth.recovering ? signIn.recoveryDisabled : signIn.signInDisabled) || auth.disabled
        }
        onClick={auth.start}
      >
        {actionLabel(signIn, auth, t)}
      </Button>
    </div>
  )
}

/** Mounted only while this client's sign-in runs, so the paste form starts closed for each flow. */
function SignInFlowPanel({
  signIn,
  alert
}: {
  signIn: AntigravityChatSignInControls
  alert: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const [pasteOpen, setPasteOpen] = useState(false)
  const { copy, url } = signIn
  return (
    <div className="space-y-3 rounded-md border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="status" className="flex min-w-0 items-center gap-2 text-xs">
          <LoadingSpinner className="size-3 shrink-0" />
          <span className="min-w-0 break-words">{signIn.line}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {url && (
            <Button size="sm" variant="outline" onClick={() => void copy.copyText()}>
              {copy.status === 'copied' ? <Check /> : <Copy />}
              {signIn.copyLabel}
            </Button>
          )}
          <Button size="sm" variant="ghost" disabled={signIn.pending} onClick={signIn.cancel}>
            {t('accounts.antigravity.chatCancel', 'Cancel')}
          </Button>
        </div>
      </div>
      {alert && <p className="text-xs">{alert}</p>}
      {url &&
        (pasteOpen ? (
          <PastedAddressForm pending={signIn.pending} send={signIn.send} />
        ) : (
          <p className="text-xs text-muted-foreground">
            <ManagedRuntimeLinkButton onClick={() => setPasteOpen(true)}>
              {t('accounts.antigravity.chatPasteOpen', "Browser page didn't load?")}
            </ManagedRuntimeLinkButton>
          </p>
        ))}
    </div>
  )
}

/** Paste Google’s final URL because browsers on other computers cannot reach the host callback directly. */
function PastedAddressForm(props: {
  pending: boolean
  send: (callbackUrl: string, refused: (message: string) => void) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [pasted, setPasted] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const helpId = useId()
  const callbackUrl = pasted.trim()
  // Let host validation explain refused addresses instead of browser URL validation preempting it.
  return (
    <form
      noValidate
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (callbackUrl) {
          props.send(callbackUrl, setRefusal)
        }
      }}
    >
      <p id={helpId} className="text-xs text-muted-foreground">
        {t(
          'accounts.antigravity.chatPasteHelp',
          "If the last page after signing in doesn't load, copy its full address from your browser and paste it here."
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="url"
          autoComplete="off"
          spellCheck={false}
          maxLength={16_384}
          aria-labelledby={helpId}
          aria-invalid={refusal !== null}
          value={pasted}
          disabled={props.pending}
          onChange={(event) => {
            setPasted(event.target.value)
            setRefusal(null)
          }}
        />
        <Button type="submit" size="sm" variant="outline" disabled={props.pending || !callbackUrl}>
          {t('accounts.antigravity.chatContinue', 'Continue')}
        </Button>
      </div>
      {refusal !== null && (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      )}
    </form>
  )
}
