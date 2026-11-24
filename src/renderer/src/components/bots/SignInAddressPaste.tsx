import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'

/**
 * A sign-in finished in a browser that can't reach the computer it signs in to ends on a page that
 * can't load; pasting that address finishes it there. A refused address says why at the field, in
 * the words `describeError` gives it.
 */
export function SignInAddressPaste({
  hint,
  onFinish,
  describeError
}: {
  hint: string
  onFinish: (address: string) => Promise<void>
  describeError: (error: unknown) => string
}): React.JSX.Element {
  const t = useTranslate()
  const [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const finish = () => {
    setBusy(true)
    setRefused(null)
    void onFinish(address)
      .then(() => setAddress(''))
      .catch((error: unknown) => setRefused(describeError(error)))
      .finally(() => setBusy(false))
  }
  return (
    <div className="mt-2 space-y-1.5">
      <p className="text-xs text-muted-foreground">{hint}</p>
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          finish()
        }}
      >
        <Input
          variant="code"
          density="compact"
          value={address}
          onChange={(event) => {
            setAddress(event.target.value)
            setRefused(null)
          }}
          aria-invalid={refused !== null}
          aria-label={t('components.bots.toolSignIn.address', 'Address')}
        />
        <Button type="submit" variant="outline" size="xs" disabled={busy || !address.trim()}>
          {t('components.bots.toolSignIn.finish', 'Finish')}
        </Button>
      </form>
      {refused ? (
        <p role="alert" className="text-xs text-destructive">
          {refused}
        </p>
      ) : null}
    </div>
  )
}
