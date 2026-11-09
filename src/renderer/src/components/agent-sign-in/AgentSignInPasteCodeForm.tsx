import { useId, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/** The code Claude's sign-in page shows, sent back to the login on the host. */
export function PasteCodeForm({
  submitting,
  refusal,
  onSubmit
}: {
  submitting: boolean
  refusal: string | null
  onSubmit: (code: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [code, setCode] = useState('')
  const labelId = useId()
  const trimmed = code.trim()
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed && !submitting) {
          onSubmit(trimmed)
        }
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          autoFocus
          autoComplete="off"
          spellCheck={false}
          maxLength={4_096}
          aria-labelledby={labelId}
          aria-invalid={refusal !== null}
          placeholder={t('agentSignIn.pasteCodePlaceholder', 'Paste code')}
          variant="code"
          value={code}
          disabled={submitting}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={submitting || !trimmed}>
          {t('agentSignIn.continue', 'Continue')}
        </Button>
      </div>
      <span id={labelId} className="sr-only">
        {t('agentSignIn.pasteCodeLabel', 'Code from the sign-in page')}
      </span>
      {refusal ? (
        <p role="alert" className="text-xs text-destructive">
          {refusal}
        </p>
      ) : null}
    </form>
  )
}
