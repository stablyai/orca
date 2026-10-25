import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Switch } from '../ui/switch'
import { SearchableSetting } from './SearchableSetting'

export function ClaudeAutoSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate('accounts.claude.autoSwitch', 'Switch accounts before a usage limit')
  const description = translate(
    'accounts.claude.autoSwitchDescription',
    'When the selected account passes 90% of its 5-hour or weekly limit, Orca switches to the account with the most room left, as if you had switched by hand.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'auto', 'switch', 'rate limit', 'quota', 'usage']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={settings.claudeAutoSwitchEnabled === true}
        onCheckedChange={(checked) => updateSettings({ claudeAutoSwitchEnabled: checked })}
      />
    </SearchableSetting>
  )
}
