import { useEffect, useId, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callAntigravityChatApiKey } from '@/runtime/provider-accounts/sign-in/runtime-antigravity-accounts-client'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AntigravityChatApiKeyStatus } from '../../../../shared/rpc-contract/accounts/antigravity-accounts-params'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ManagedRuntimeLinkButton } from '../managed-runtime/ManagedRuntimeLinkButton'

const GET_KEY_URL = 'https://aistudio.google.com/apikey'

type Props = {
  owner: RuntimeClientTarget
  disabled: boolean
  onStatus: (status: AntigravityChatApiKeyStatus | null) => void
  /** A newly saved key signs the chat in right away. */
  onSaved: () => void
}

/** Paste a Gemini API key, kept encrypted on the chat's host; GEMINI_API_KEY is the fallback. */
export function AntigravityChatApiKeyField({
  owner,
  disabled,
  onStatus,
  onSaved
}: Props): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const [status, setStatus] = useState<AntigravityChatApiKeyStatus | null>(null)
  const [draft, setDraft] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const environmentId = owner.kind === 'environment' ? owner.environmentId : null

  useEffect(() => {
    let current = true
    const target: RuntimeClientTarget =
      environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }
    callAntigravityChatApiKey(target, { kind: 'status' }).then(
      (next) => current && setStatus(next),
      () => current && setStatus(null)
    )
    return () => {
      current = false
    }
  }, [environmentId])
  useEffect(() => onStatus(status), [status, onStatus])

  const run = (action: { kind: 'save'; apiKey: string } | { kind: 'clear' }): void => {
    setPending(true)
    setError(null)
    callAntigravityChatApiKey(owner, action)
      .then((next) => {
        setStatus(next)
        setDraft('')
        setReplacing(false)
        if (action.kind === 'save') {
          onSaved()
        }
      })
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : t('accounts.antigravity.apiKeySaveFailed', "Orca couldn't save the key. Try again.")
        )
      )
      .finally(() => setPending(false))
  }
  const busy = disabled || pending
  const editing = !status?.saved || replacing
  const hint = status?.saved
    ? t('accounts.antigravity.apiKeySaved', 'Key saved on this host, encrypted.')
    : status?.inEnvironment
      ? t(
          'accounts.antigravity.apiKeyFromEnvironment',
          'Using GEMINI_API_KEY from your environment. Paste a key to use a different one.'
        )
      : null

  return (
    <div className="space-y-1.5">
      <Label htmlFor={`${id}-key`}>{t('accounts.antigravity.apiKeyLabel', 'Gemini API key')}</Label>
      {editing ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (draft.trim()) {
              run({ kind: 'save', apiKey: draft })
            }
          }}
        >
          <Input
            id={`${id}-key`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={draft}
            disabled={busy}
            placeholder={t('accounts.antigravity.apiKeyPlaceholder', 'Paste your API key')}
            onChange={(event) => {
              setDraft(event.target.value)
              setError(null)
            }}
          />
          <Button type="submit" size="sm" disabled={busy || !draft.trim()}>
            {t('accounts.antigravity.apiKeySave', 'Save')}
          </Button>
          {replacing && (
            <Button type="button" size="sm" variant="ghost" onClick={() => setReplacing(false)}>
              {t('accounts.antigravity.chatCancel', 'Cancel')}
            </Button>
          )}
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setReplacing(true)}>
            {t('accounts.antigravity.apiKeyReplace', 'Replace key')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => run({ kind: 'clear' })}>
            {t('accounts.antigravity.apiKeyRemove', 'Remove')}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {hint ? `${hint} ` : null}
          {!status?.saved && (
            <ManagedRuntimeLinkButton onClick={() => openAppHttpLink(GET_KEY_URL)}>
              {t('accounts.antigravity.apiKeyGet', 'Get API key')}
            </ManagedRuntimeLinkButton>
          )}
        </p>
      )}
    </div>
  )
}
