import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

export function OpenCodeGoCredentials({ onSaved }: { onSaved: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [configured, setConfigured] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let active = true
    void window.api.opencodeGoCredentials.getStatus().then(
      (status) => {
        if (active) {
          setConfigured(status.apiKeyConfigured)
        }
      },
      () => console.error('Failed to load OpenCode Go credential status')
    )
    return () => {
      active = false
    }
  }, [])

  const updateCredential = async (clear: boolean): Promise<void> => {
    setBusy(true)
    try {
      const status = clear
        ? await window.api.opencodeGoCredentials.clearApiKey()
        : await window.api.opencodeGoCredentials.saveApiKey(draft.trim())
      setConfigured(status.apiKeyConfigured)
      setDraft('')
      onSaved()
    } catch {
      toast.error(translate('sessionHistory.settings.saveError', 'Could not save. Try again.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.opencodeGo.apiKey.title',
        'OpenCode Go API Key'
      )}
      description={translate(
        'auto.components.settings.AccountsPane.opencodeGo.apiKey.description',
        'Optional override. Orca otherwise uses the key OpenCode saved when you ran /connect, then OPENCODE_API_KEY.'
      )}
      keywords={['opencode', 'go', 'api', 'key', 'connect', 'rate limit', 'status bar']}
      className="space-y-2"
    >
      <div className="flex items-center gap-2">
        <Label htmlFor="opencode-go-api-key">
          {translate(
            'auto.components.settings.AccountsPane.opencodeGo.apiKey.label',
            'OpenCode Go API key'
          )}
        </Label>
        <Badge variant={configured ? 'secondary' : 'outline'}>
          {configured
            ? translate('auto.components.settings.AccountsPane.73ea15f24b', 'Saved')
            : translate('auto.components.settings.AccountsPane.23afe8f226', 'Not saved')}
        </Badge>
      </div>
      <div className="flex gap-2">
        <Input
          id="opencode-go-api-key"
          type="password"
          value={draft}
          disabled={busy}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={translate(
            'auto.components.settings.AccountsPane.opencodeGo.apiKey.placeholder',
            'Leave blank to use the key saved by /connect or OPENCODE_API_KEY'
          )}
          spellCheck={false}
          className="flex-1 text-xs"
        />
        <Button
          size="xs"
          disabled={busy || !draft.trim()}
          onClick={() => void updateCredential(false)}
        >
          {configured
            ? translate('auto.components.settings.AccountsPane.f38b9cc4bd', 'Replace')
            : translate('auto.components.settings.AccountsPane.590a3130f9', 'Save')}
        </Button>
        {configured && (
          <Button
            variant="ghost"
            size="xs"
            disabled={busy}
            onClick={() => void updateCredential(true)}
          >
            {translate('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.AccountsPane.opencodeGo.apiKey.help',
          'Used for OpenCode Go usage in the status bar. The session cookie below is only needed for legacy console (OpenCode Black) accounts.'
        )}
      </p>
    </SearchableSetting>
  )
}
