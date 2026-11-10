import { translate } from '../../../../i18n/i18n'
import type { Translate } from '../../../../i18n/use-translate'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { GeminiIcon } from '../../../status-bar/icons'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

export function renderGeminiAccountsSection(
  model: AccountsPaneSectionModel,
  t: Translate = translate
): React.JSX.Element {
  const { localAccountRuntimeSentenceLabel, recordFeatureInteraction, settings, updateSettings } =
    model
  return (
    <div key="gemini" id="accounts-gemini" className="scroll-mt-6">
      <SettingsGroup
        title={
          <span className="flex items-center gap-2">
            <GeminiIcon size={16} />
            {t('auto.components.settings.AccountsPane.0c64dc2a64', 'Gemini CLI (legacy)')}
          </span>
        }
        description={t(
          'auto.components.settings.AccountsPane.973741a871',
          'Keep existing Gemini CLI sessions available. Gemini credentials do not sign you into Antigravity.'
        )}
      >
        <SearchableSetting
          title={t(
            'auto.components.settings.AccountsPane.0c7f915b01',
            'Use Gemini CLI credentials'
          )}
          description={t(
            'auto.components.settings.AccountsPane.d676c41fc6',
            'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google. This uses credentials issued to the Gemini CLI app, not Orca. May break if Google updates the CLI. Use at your own risk.'
          )}
          keywords={[
            'gemini',
            'cli',
            'oauth',
            'credentials',
            'experimental',
            'rate limit',
            'status bar'
          ]}
          className="flex items-center justify-between gap-4 py-3"
        >
          <div className="space-y-0.5">
            <Label>
              {t(
                'auto.components.settings.AccountsPane.96f3649526',
                'Use Gemini CLI credentials (experimental)'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                'auto.components.settings.AccountsPane.c2aee76420',
                'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google for {{value0}}. This uses credentials issued to the Gemini CLI app, not Orca. May break if Google updates the CLI. Use at your own risk.',
                { value0: localAccountRuntimeSentenceLabel }
              )}
            </p>
          </div>
          <Switch
            aria-label={t(
              'auto.components.settings.AccountsPane.96f3649526',
              'Use Gemini CLI credentials (experimental)'
            )}
            checked={settings.geminiCliOAuthEnabled}
            onCheckedChange={(checked) => {
              recordFeatureInteraction('usage-tracking')
              updateSettings({
                geminiCliOAuthEnabled: checked
              })
            }}
          />
        </SearchableSetting>
      </SettingsGroup>
    </div>
  )
}
