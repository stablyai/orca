import { Loader2 } from 'lucide-react'
import type { ClinePassCredentialsStatus } from '../../../../shared/clinepass-credentials'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'

type ClinePassApiKeyFormProps = {
  source: ClinePassCredentialsStatus['source']
  draft: string
  draftInvalid: boolean
  busy: boolean
  statusLoading: boolean
  onDraftChange: (value: string) => void
  onSave: () => Promise<void>
  onClear: () => Promise<void>
}

export function ClinePassApiKeyForm({
  source,
  draft,
  draftInvalid,
  busy,
  statusLoading,
  onDraftChange,
  onSave,
  onClear
}: ClinePassApiKeyFormProps): React.JSX.Element {
  const isStored = source === 'stored'
  const isEnvironment = source === 'environment'

  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.ClinePassAccountsSection.c89556fc40',
        'ClinePass API key'
      )}
      description={translate(
        'auto.components.settings.ClinePassAccountsSection.3d738f9c5f',
        'Authenticate quota refreshes with an official Cline API key.'
      )}
      keywords={[
        'clinepass',
        'cline',
        'subscription',
        'quota',
        'api key',
        'CLINE_API_KEY',
        '5-hour',
        'weekly',
        'monthly',
        'rate limit',
        'status bar'
      ]}
      className="space-y-2"
      forceVisible
    >
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="clinepass-api-key">
          {translate(
            'auto.components.settings.ClinePassAccountsSection.c89556fc40',
            'ClinePass API key'
          )}
        </Label>
        {isEnvironment ? (
          <span className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.ClinePassAccountsSection.7e87f4df2a',
              'A saved key overrides the environment'
            )}
          </span>
        ) : null}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void onSave()
        }}
      >
        <Input
          id="clinepass-api-key"
          type="password"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          placeholder={translate(
            'auto.components.settings.ClinePassAccountsSection.ce12d5e9c6',
            'Paste a Cline API key'
          )}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="off"
          aria-invalid={draftInvalid}
          disabled={busy}
          className="flex-1 text-xs"
        />
        <Button
          type="submit"
          size="xs"
          disabled={busy || statusLoading}
          className="h-7 shrink-0 text-xs"
        >
          {busy ? <Loader2 className="size-3 animate-spin" /> : null}
          {isStored
            ? translate('auto.components.settings.ClinePassAccountsSection.61a2148925', 'Replace')
            : translate('auto.components.settings.ClinePassAccountsSection.3fc8e072dc', 'Save')}
        </Button>
        {isStored ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => void onClear()}
            disabled={busy}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate(
              'auto.components.settings.ClinePassAccountsSection.535a2c9a19',
              'Forget API key'
            )}
          </Button>
        ) : null}
      </form>
      {draftInvalid ? (
        <p role="alert" className="text-xs text-destructive">
          {translate(
            'auto.components.settings.ClinePassAccountsSection.f036f412e9',
            'ClinePass API key is required.'
          )}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ClinePassAccountsSection.a11dc5b121',
          'Create an API key in your Cline account, then paste it here. Orca never displays a saved key.'
        )}
      </p>
    </SearchableSetting>
  )
}
