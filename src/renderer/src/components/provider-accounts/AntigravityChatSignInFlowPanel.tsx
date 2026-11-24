import { useId, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { AntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

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
