import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTranslate } from '@/i18n/use-translate'
import {
  KEPT_PROMPT_VIEWS,
  useNativeChatViewGuard
} from '../native-chat/pane/ownership/native-chat-view-memory'

/**
 * A sign-in finished in a browser that can't reach the computer it signs in to ends on a page that
 * can't load; pasting that address finishes it there. A refused address says why at the field, in
 * the words `describeError` gives it.
 */
export function SignInAddressPaste({
  hint,
  onFinish,
  describeError,
  memoryKey
}: {
  hint: string
  /** The sign-in it finishes, for a card in a chat: it stays busy through a switch. */
  memoryKey?: string
  onFinish: (address: string) => Promise<void>
  describeError: (error: unknown) => string
}): React.JSX.Element {
  const t = useTranslate()
  // Kept with the chat tab when shown in a chat: a card released mid-finish returns still finishing, or with the
  // refused address and why, to correct it.
  const [busy, setBusy] = useNativeChatViewGuard(
    memoryKey === undefined ? undefined : `sign-in-address:${memoryKey}`,
    false
  )
  const [refusal, setRefusal] = useNativeChatViewGuard<{ address: string; why: string } | null>(
    memoryKey === undefined ? undefined : `sign-in-address-refused:${memoryKey}`,
    null,
    KEPT_PROMPT_VIEWS
  )
  const [address, setAddress] = useState(() => refusal?.address ?? '')
  // A refusal landing after this view mounted brings back the address it refused, unless something was typed since.
  const [seenRefusal, setSeenRefusal] = useState(refusal)
  if (refusal !== seenRefusal) {
    setSeenRefusal(refusal)
    if (refusal && address === '') {
      setAddress(refusal.address)
    }
  }
  const refused = refusal?.why ?? null
  const finish = () => {
    const tried = address
    setBusy(true)
    setRefusal(null)
    void onFinish(tried)
      .then(() => setAddress(''))
      .catch((error: unknown) => setRefusal({ address: tried, why: describeError(error) }))
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
            setRefusal(null)
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
