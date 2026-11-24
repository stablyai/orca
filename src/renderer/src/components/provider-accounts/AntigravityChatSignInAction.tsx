import { useId, useState } from 'react'
import { AlertCircle, Check, Copy } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { AntigravityChatAuthAction } from './AntigravityChatAuthForm'
import type { AntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

function SignInAlert({ message }: { message: string | null }): React.JSX.Element | null {
  return message ? (
    <span role="alert" className="flex items-center gap-1.5 text-destructive">
      <AlertCircle className="size-3.5 shrink-0" />
      {message}
    </span>
  ) : null
}

function SignInButton({
  signIn,
  auth
}: {
  signIn: AntigravityChatSignInControls
  auth: AntigravityChatAuthAction
}): React.JSX.Element {
  const t = useTranslate()
  // A cancelled or failed switch leaves agy signed in, so it still offers a change, not a first sign-in.
  const changing = signIn.auth === 'signedIn'
  const label = changing
    ? t('accounts.antigravity.chatChangeAccount', 'Change account')
    : auth.method && !auth.recovering
      ? t('accounts.antigravity.chatSignInWith', 'Sign in with {{method}}', {
          method: auth.method
        })
      : signIn.action === 'retry'
        ? t('accounts.antigravity.chatRetry', 'Retry sign-in')
        : t('accounts.antigravity.chatSignIn', 'Sign in')
  return (
    <Button
      size="xs"
      variant={changing ? 'outline' : 'default'}
      disabled={
        (auth.recovering ? signIn.recoveryDisabled : signIn.signInDisabled) || auth.disabled
      }
      onClick={auth.start}
    >
      {label}
    </Button>
  )
}

function StatusDot({ className }: { className: string }): React.JSX.Element {
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', className)} />
}

/** Settings row: "Account" over its status line, with the action beside it; a running sign-in renders in place. */
export function AntigravityChatAccountRow({
  signIn,
  auth
}: {
  signIn: AntigravityChatSignInControls
  auth: AntigravityChatAuthAction
}): React.JSX.Element {
  const t = useTranslate()
  const title = (
    <p className="text-sm font-medium">{t('accounts.antigravity.account', 'Account')}</p>
  )
  if (signIn.ownFlow) {
    return (
      <div data-settings-row="" className="py-3">
        <AntigravityChatSignInFlowPanel
          signIn={signIn}
          alert={auth.alert ? <SignInAlert message={auth.alert} /> : null}
          title={title}
        />
      </div>
    )
  }
  const hint = auth.incomplete
    ? t('accounts.antigravity.enterpriseFieldsShort', 'Enter a project and location.')
    : null
  const state =
    signIn.auth === 'signedIn'
      ? {
          dot: 'bg-status-success',
          text: t('accounts.antigravity.chatBadgeSignedIn', 'Signed in')
        }
      : signIn.auth === 'signedOut'
        ? {
            dot: 'bg-muted-foreground/60',
            text: t('accounts.antigravity.chatBadgeSignedOut', 'Not signed in')
          }
        : null
  const status = auth.alert ? (
    <SignInAlert message={auth.alert} />
  ) : signIn.line ? (
    <>
      {signIn.signingIn ? <LoadingSpinner className="size-3 shrink-0" /> : null}
      <span className="min-w-0 break-words">{signIn.line}</span>
    </>
  ) : (
    <>
      {state ? <StatusDot className={state.dot} /> : null}
      {[state?.text, hint].filter(Boolean).join(' · ')}
    </>
  )
  return (
    <div data-settings-row="" className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0 flex-1">
        {title}
        <div
          role="status"
          className="mt-0.5 flex min-h-4 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
        >
          {status}
        </div>
      </div>
      <SignInButton signIn={signIn} auth={auth} />
    </div>
  )
}

/** This client's running sign-in: Google's link to copy, and the box for what Google shows after. */
export function AntigravityChatSignInFlowPanel({
  signIn,
  alert,
  title
}: {
  signIn: AntigravityChatSignInControls
  alert: React.ReactNode
  /** A titled panel sits inside a settings row, so it drops its own frame. */
  title?: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const { copy, url } = signIn
  const size = title ? 'xs' : 'sm'
  return (
    <div className={cn('space-y-3', !title && 'rounded-md border border-border bg-muted/30 p-3')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          {title}
          <div
            role="status"
            className={cn(
              'flex min-w-0 items-center gap-2 text-xs',
              title && 'mt-0.5 text-muted-foreground'
            )}
          >
            <LoadingSpinner className="size-3 shrink-0" />
            <span className="min-w-0 break-words">{signIn.line}</span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {url && (
            <Button size={size} variant="outline" onClick={() => void copy.copyText()}>
              {copy.status === 'copied' ? <Check /> : <Copy />}
              {signIn.copyLabel}
            </Button>
          )}
          <Button size={size} variant="ghost" disabled={signIn.pending} onClick={signIn.cancel}>
            {t('accounts.antigravity.chatCancel', 'Cancel')}
          </Button>
        </div>
      </div>
      {alert && <p className="text-xs">{alert}</p>}
      {url && <PastedCodeForm pending={signIn.pending} send={signIn.send} />}
    </div>
  )
}

/** agy reads its sign-in back from what Google shows: the code, or the address of that page. */
function PastedCodeForm(props: {
  pending: boolean
  send: (pasted: string, refused: (message: string) => void) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [pasted, setPasted] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const helpId = useId()
  const answer = pasted.trim()
  return (
    <form
      noValidate
      className="space-y-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (answer) {
          props.send(answer, setRefusal)
        }
      }}
    >
      <p id={helpId} className="text-xs text-muted-foreground">
        {t(
          'accounts.antigravity.chatPasteCodeHelp',
          "Sign in with Google in your browser, then paste the code it shows here (or that page's address)."
        )}
      </p>
      <div className="flex items-center gap-2">
        <Input
          type="text"
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
        <Button type="submit" size="sm" variant="outline" disabled={props.pending || !answer}>
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
