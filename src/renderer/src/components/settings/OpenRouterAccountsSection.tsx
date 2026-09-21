import { useCallback, useEffect, useState } from 'react'
import { ExternalLink, Loader2, ShieldCheck } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { OpenRouterIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import { getAccountsOpenRouterSearchEntries } from './accounts-search'

const OPENROUTER_KEYS_URL = 'https://openrouter.ai/settings/keys'

/**
 * OpenRouter credential settings.
 *
 * Self-contained like GrokAccountsSection: the key never enters GlobalSettings
 * or the AccountsPane model, so nothing here is carried in a settings snapshot.
 * The draft lives in local state and is cleared the moment it is handed to main.
 */
export function OpenRouterAccountsSection(): React.JSX.Element {
  const [searchEntry] = getAccountsOpenRouterSearchEntries()
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadStatus = useCallback(async (): Promise<void> => {
    try {
      const status = await window.api.openrouterCredentials.getStatus()
      setApiKeyConfigured(status.apiKeyConfigured)
    } catch (loadError) {
      console.error('Failed to load OpenRouter credential status:', loadError)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const handleSave = async (): Promise<void> => {
    const trimmed = draft.trim()
    if (!trimmed) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const status = await window.api.openrouterCredentials.saveApiKey(trimmed)
      setApiKeyConfigured(status.apiKeyConfigured)
      // Why: drop the plaintext draft as soon as main owns it, so the key is not
      // left sitting in renderer state behind a closed settings pane.
      setDraft('')
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : 'Failed to save the OpenRouter API key'
      )
    } finally {
      setBusy(false)
    }
  }

  const handleClear = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const status = await window.api.openrouterCredentials.clearApiKey()
      setApiKeyConfigured(status.apiKeyConfigured)
      setDraft('')
    } catch (clearError) {
      setError(
        clearError instanceof Error ? clearError.message : 'Failed to clear the OpenRouter API key'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <section key="openrouter" id="accounts-openrouter" className="space-y-4 scroll-mt-6">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <OpenRouterIcon size={16} />
            {translate('auto.components.settings.AccountsPane.openrouterTitle', 'OpenRouter')}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.AccountsPane.openrouterDescription',
              'Track spend against the limit set on your OpenRouter API key.'
            )}
          </p>
        </div>
        <a
          href={OPENROUTER_KEYS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {translate('auto.components.settings.AccountsPane.openrouterKeys', 'Manage keys')}
          <ExternalLink className="size-3" />
        </a>
      </div>

      {/* Why the catalog entry is threaded in: this filter matches only its own
          title, description and keywords — it does not inherit the parent
          section's entry. Without them a search that mounts the section (say
          "credits") would then hide the controls inside it. */}
      <SearchableSetting
        id="accounts-openrouter-api-key"
        title={translate(
          'auto.components.settings.AccountsPane.openrouterApiKey',
          'OpenRouter API key'
        )}
        description={searchEntry.description}
        keywords={searchEntry.keywords}
      >
        <div className="space-y-2">
          <Label htmlFor="openrouter-api-key" className="text-xs">
            {translate(
              'auto.components.settings.AccountsPane.openrouterApiKey',
              'OpenRouter API key'
            )}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="openrouter-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              disabled={busy}
              placeholder={
                apiKeyConfigured
                  ? translate(
                      'auto.components.settings.AccountsPane.openrouterKeySaved',
                      'A key is saved — enter a new one to replace it'
                    )
                  : 'sk-or-v1-…'
              }
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button size="sm" onClick={() => void handleSave()} disabled={busy || !draft.trim()}>
              {busy ? <Loader2 className="size-3 animate-spin" /> : null}
              {translate('auto.components.settings.AccountsPane.openrouterSave', 'Save')}
            </Button>
            {apiKeyConfigured ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleClear()}
                disabled={busy}
              >
                {translate('auto.components.settings.AccountsPane.openrouterClear', 'Clear')}
              </Button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={apiKeyConfigured ? 'secondary' : 'outline'} className="gap-1">
              <ShieldCheck className={cn('size-3', apiKeyConfigured && 'text-emerald-500')} />
              {apiKeyConfigured
                ? translate(
                    'auto.components.settings.AccountsPane.openrouterConfigured',
                    'Key saved'
                  )
                : translate(
                    'auto.components.settings.AccountsPane.openrouterNotConfigured',
                    'Not configured'
                  )}
            </Badge>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.AccountsPane.openrouterStorageNote',
                'Kept on this computer and never included in settings sync. Encrypted when your system keyring is available.'
              )}
            </p>
          </div>
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
        </div>
      </SearchableSetting>
    </section>
  )
}
