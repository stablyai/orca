import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function ClaudeUsageLimitSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t(
    'accounts.claude.usageLimitSwitch.title',
    'Switch accounts when Claude reaches a usage limit'
  )
  const description = t(
    'accounts.claude.usageLimitSwitch.description',
    'Selects the saved account whose weekly limit resets soonest once the current one runs out of its 5-hour or weekly usage.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'switch', 'automatic', 'usage', 'limit', 'rotate']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label htmlFor="claude-usage-limit-switch">{title}</Label>
        <p id="claude-usage-limit-switch-description" className="text-xs text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id="claude-usage-limit-switch"
        aria-describedby="claude-usage-limit-switch-description"
        checked={settings.claudeAccountSwitchAtUsageLimit === true}
        onCheckedChange={(checked) => updateSettings({ claudeAccountSwitchAtUsageLimit: checked })}
      />
    </SearchableSetting>
  )
}
