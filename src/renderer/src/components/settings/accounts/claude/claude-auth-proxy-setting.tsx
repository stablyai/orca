import { claudeAuthProxyEnabled } from '../../../../../../shared/claude-account-switch-settings'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import { translate } from '@/i18n/i18n'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function ClaudeAuthProxySetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate(
    'accounts.claude.authProxy.settingTitle',
    'Bill Claude through a local auth proxy'
  )
  const description = translate(
    'accounts.claude.authProxy.settingDescription',
    'A running Claude session can change accounts without restarting. The next request uses the new account.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'proxy', 'auth', 'restart', 'session']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch
        aria-label={title}
        checked={claudeAuthProxyEnabled(settings)}
        onCheckedChange={(enabled) => updateSettings({ claudeAuthProxy: enabled })}
      />
    </SearchableSetting>
  )
}
