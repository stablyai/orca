import { translate } from '@/i18n/i18n'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'

type ClaudeOAuthUsageSettingProps = Pick<
  AccountsPaneSectionModel,
  'settings' | 'updateSettings' | 'recordFeatureInteraction'
>

export function ClaudeOAuthUsageSetting({
  settings,
  updateSettings,
  recordFeatureInteraction
}: ClaudeOAuthUsageSettingProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.AccountsPane.73f26694ad',
        'Claude usage from your sign-in'
      )}
      description={translate(
        'auto.components.settings.AccountsPane.688fd1f924',
        "Lets Orca read your Claude Code sign-in token and call Anthropic's usage endpoint for the status bar. Off, usage comes only from running Claude Code sessions and Orca does not read your Claude token."
      )}
      keywords={['claude', 'usage', 'oauth', 'credentials', 'rate limit', 'status bar']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="space-y-0.5">
        <Label>
          {translate(
            'auto.components.settings.AccountsPane.73f26694ad',
            'Claude usage from your sign-in'
          )}
        </Label>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.AccountsPane.688fd1f924',
            "Lets Orca read your Claude Code sign-in token and call Anthropic's usage endpoint for the status bar. Off, usage comes only from running Claude Code sessions and Orca does not read your Claude token."
          )}
        </p>
      </div>
      <Switch
        aria-label={translate(
          'auto.components.settings.AccountsPane.73f26694ad',
          'Claude usage from your sign-in'
        )}
        checked={settings.claudeOAuthUsageEnabled}
        onCheckedChange={(checked) => {
          recordFeatureInteraction('usage-tracking')
          updateSettings({ claudeOAuthUsageEnabled: checked })
        }}
      />
    </SearchableSetting>
  )
}
