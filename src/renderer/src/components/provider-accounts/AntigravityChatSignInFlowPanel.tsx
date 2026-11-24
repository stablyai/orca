import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { LoadingSpinner } from '../ui/LoadingSpinner'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import type { AntigravityChatSignInControls } from './use-antigravity-chat-sign-in'

/** This client's running sign-in: its status with a quiet Cancel, then one box for what Google
 *  shows after sign-in, with the link to copy should the browser not have opened. */
export function AntigravityChatSignInFlowPanel({
  signIn,
  title
}: {
  signIn: AntigravityChatSignInControls
  title: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  const verifying = signIn.flow?.phase === 'verifying'
  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          {title}
          <p
            role="status"
            aria-live="polite"
            className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
          >
            <LoadingSpinner className="size-3 shrink-0" />
            <span className="min-w-0 break-words">{signIn.line}</span>
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={signIn.pending}
          aria-label={t('accounts.antigravity.chatCancelSignIn', 'Cancel sign-in')}
          title={t('accounts.antigravity.chatCancelSignIn', 'Cancel sign-in')}
          onClick={signIn.cancel}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {signIn.url || verifying ? <PastedCodeForm signIn={signIn} verifying={verifying} /> : null}
    </div>
  )
}

/** agy reads its sign-in back from what Google shows: the code, or the address of that page. */
function PastedCodeForm({
  signIn,
  verifying
}: {
  signIn: AntigravityChatSignInControls
  verifying: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const [pasted, setPasted] = useState('')
  const [refusal, setRefusal] = useState<string | null>(null)
  const inputId = useId()
  const answer = pasted.trim()
  const busy = verifying || signIn.pending
  return (
    <form
      noValidate
      className="space-y-1.5"
      onSubmit={(event) => {
        event.preventDefault()
        if (answer && !busy) {
          signIn.send(answer, setRefusal)
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          type="text"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={16_384}
          className="h-8"
          placeholder={t('accounts.antigravity.chatPasteCode', 'Paste the code')}
          aria-label={t(
            'accounts.antigravity.chatPasteCodeLabel',
            "The code Google shows after you sign in, or that page's address"
          )}
          aria-invalid={refusal !== null}
          value={pasted}
          disabled={busy}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              signIn.cancel()
            }
          }}
          onChange={(event) => {
            setPasted(event.target.value)
            setRefusal(null)
          }}
        />
        <Button
          type="submit"
          size="sm"
          variant="outline-strong"
          className="min-w-20"
          disabled={busy || !answer}
        >
          {busy ? (
            <LoadingSpinner className="size-3.5" />
          ) : (
            t('accounts.antigravity.chatContinue', 'Continue')
          )}
        </Button>
      </div>
      {refusal !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      ) : signIn.url ? (
        <p className="text-xs text-muted-foreground">
          {t('accounts.antigravity.chatPageDidntOpen', "Page didn't open?")}{' '}
          <Button
            type="button"
            variant="link-underlined"
            size="inlineText"
            onClick={() => void signIn.copy.copyText()}
          >
            {signIn.copy.status === 'copied'
              ? t('accounts.antigravity.chatCopied', 'Copied')
              : t('accounts.antigravity.chatCopySignInLink', 'Copy the sign-in link')}
          </Button>
        </p>
      ) : null}
    </form>
  )
}
