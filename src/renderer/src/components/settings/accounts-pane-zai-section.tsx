import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ZaiIcon } from '../status-bar/icons'
import { SearchableSetting } from './SearchableSetting'
import type { AccountsPaneSectionModel } from './accounts-pane-types'

/** Renders the Accounts pane section that stores the Z.ai API key used for GLM Coding Plan usage. */
export function renderZaiAccountsSection(model: AccountsPaneSectionModel): React.JSX.Element {
  const { recordFeatureInteraction, settings, updateSettings } = model
  return (
    <section key="zai" id="accounts-zai" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ZaiIcon size={16} />
          {translate('auto.components.settings.AccountsPane.zaiTitle', 'Z.ai')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.zaiSubtitle',
            'Configure Z.ai GLM Coding Plan usage.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate('auto.components.settings.AccountsPane.zaiApiKeyTitle', 'Z.ai API Key')}
        description={translate(
          'auto.components.settings.AccountsPane.zaiApiKeyDescription',
          'Paste your Z.ai API key to show GLM Coding Plan quota in the status bar.'
        )}
        keywords={['z.ai', 'zai', 'glm', 'api key', 'rate limit', 'status bar']}
        className="space-y-2"
      >
        <Label>
          {translate('auto.components.settings.AccountsPane.zaiApiKeyLabel', 'Z.ai API key')}
        </Label>
        <div className="flex gap-2">
          <Input
            type="password"
            value={settings.zaiApiKey}
            onChange={(e) => {
              recordFeatureInteraction('usage-tracking')
              updateSettings({ zaiApiKey: e.target.value })
            }}
            placeholder={translate(
              'auto.components.settings.AccountsPane.zaiApiKeyPlaceholder',
              'API key from z.ai → API Keys'
            )}
            spellCheck={false}
            className="flex-1 text-xs"
          />
          {settings.zaiApiKey && (
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                recordFeatureInteraction('usage-tracking')
                updateSettings({ zaiApiKey: '' })
              }}
              className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {translate('auto.components.settings.AccountsPane.b398b834c9', 'Clear')}
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.zaiApiKeyHint',
            'The key is stored encrypted and used only for the GLM Coding Plan quota endpoint. A Coding Plan subscription is required — pay-as-you-go keys report no quota windows.'
          )}
        </p>
      </SearchableSetting>
    </section>
  )
}
