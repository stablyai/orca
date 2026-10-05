import { useEffect, useRef, useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useDeepSeekAccount } from '@/hooks/useDeepSeekAccount'
import { mutateDeepSeekAccount, refreshDeepSeekAccount } from '@/runtime/deepseek-account-client'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { MonetaryBalanceDetails } from '../status-bar/MonetaryBalanceDetails'

export function DeepSeekAccountsSection({
  environmentId,
  unsupportedRuntime,
  scopeLabel
}: {
  environmentId: string | null
  unsupportedRuntime: boolean
  scopeLabel: string
}): React.JSX.Element {
  const state = useDeepSeekAccount(environmentId, unsupportedRuntime)
  return (
    <DeepSeekAccountForm
      key={state.account?.supported ? state.account.ownerId || null : null}
      environmentId={environmentId}
      scopeLabel={scopeLabel}
      state={state}
    />
  )
}

function DeepSeekAccountForm({
  environmentId,
  scopeLabel,
  state: { account, limits, readFailed, setStatus }
}: {
  environmentId: string | null
  scopeLabel: string
  state: ReturnType<typeof useDeepSeekAccount>
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const target = environmentId
    ? { kind: 'environment' as const, environmentId }
    : { kind: 'local' as const }
  const act = async (action: 'save' | 'remove' | 'refresh'): Promise<void> => {
    if (!account?.ownerId || busy) {
      return
    }
    setBusy(true)
    setFailed(false)
    const enteredKey = draft.trim()
    setDraft('')
    try {
      if (action === 'refresh') {
        await refreshDeepSeekAccount(target, account.ownerId)
      } else {
        const next = await mutateDeepSeekAccount(target, account.ownerId, action, enteredKey)
        if (live.current) {
          setStatus(next)
        }
      }
    } catch {
      if (live.current) {
        setFailed(true)
      }
    } finally {
      if (live.current) {
        setBusy(false)
      }
    }
  }
  return (
    <section id="accounts-deepseek" className="space-y-3 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{translate('deepseek.name', 'DeepSeek')}</h3>
          <p className="text-xs text-muted-foreground">
            {translate('deepseek.accounts.scope', 'Balance and API key belong to {{host}}.', {
              host: scopeLabel
            })}
          </p>
        </div>
        <a
          href="https://platform.deepseek.com/api_keys"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('deepseek.accounts.keys', 'DeepSeek API keys')}
          <ExternalLink className="size-3" />
        </a>
      </div>
      {readFailed ? (
        <p className="text-xs text-destructive">
          {translate(
            'deepseek.accounts.readFailed',
            'Could not read this host’s DeepSeek account.'
          )}
        </p>
      ) : !account ? (
        <p className="text-xs text-muted-foreground">
          {translate('deepseek.accounts.loading', 'Checking account…')}
        </p>
      ) : !account.supported ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'deepseek.accounts.unsupported',
            'DeepSeek accounts are unsupported on this host. Protected credential storage and balance support are required.'
          )}
        </p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {account.configured
              ? account.protection === 'sealed'
                ? translate('deepseek.accounts.saved', 'API key saved in protected storage.')
                : translate(
                    'deepseek.accounts.unverified',
                    'The saved API key could not be verified. Remove it or save a replacement.'
                  )
              : translate(
                  'deepseek.accounts.empty',
                  'Save a DeepSeek API key to check your prepaid balance.'
                )}
          </p>
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              void act('save')
            }}
          >
            <Label htmlFor="deepseek-api-key">
              {translate('deepseek.accounts.keyLabel', 'DeepSeek API key')}
            </Label>
            <Input
              id="deepseek-api-key"
              type="password"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
            <div className="flex gap-2">
              <Button size="xs" type="submit" disabled={busy || !draft.trim()}>
                {translate('deepseek.accounts.save', 'Save key')}
              </Button>
              {account.configured ? (
                <>
                  <Button
                    size="xs"
                    variant="outline"
                    type="button"
                    disabled={busy}
                    onClick={() => void act('refresh')}
                  >
                    {translate('deepseek.accounts.refresh', 'Refresh balance')}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    type="button"
                    disabled={busy}
                    onClick={() => void act('remove')}
                  >
                    {translate('deepseek.accounts.remove', 'Remove key')}
                  </Button>
                </>
              ) : null}
            </div>
          </form>
          {limits && account.configured ? <MonetaryBalanceDetails p={limits} /> : null}
          {failed ? (
            <p role="alert" className="text-xs text-destructive">
              {translate(
                'deepseek.accounts.actionFailed',
                'DeepSeek account change failed. Check host availability and protected storage, then retry.'
              )}
            </p>
          ) : null}
        </>
      )}
    </section>
  )
}
