import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function ClaudeAccountPoolSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate('accounts.claude.pool.settingTitle', 'Spread sessions across accounts')
  const description = translate(
    'accounts.claude.pool.settingDescription',
    'New Claude sessions start on the signed-in account with the most room left.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'pool', 'session', 'spread']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={settings.claudeAccountPool === 'on'}
        onCheckedChange={(enabled) => updateSettings({ claudeAccountPool: enabled ? 'on' : 'off' })}
      />
    </SearchableSetting>
  )
}
