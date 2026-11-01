import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../shared/claude-account-switch-settings'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'

const POLICIES: readonly ClaudeAccountSwitchRunningSessions[] = ['ask', 'restart', 'keep']

function isPolicy(value: string): value is ClaudeAccountSwitchRunningSessions {
  return POLICIES.some((policy) => policy === value)
}

export function ClaudeRunningSessionSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate(
    'accounts.claude.switchSessions.settingTitle',
    'When you switch accounts while Claude is running in terminals'
  )
  const description = translate(
    'accounts.claude.switchSessions.settingDescription',
    'Restarting continues each terminal conversation on the new account.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'switch', 'restart', 'running', 'session']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={settings.claudeAccountSwitchRunningSessions ?? 'ask'}
        onValueChange={(value) => {
          if (isPolicy(value)) {
            updateSettings({ claudeAccountSwitchRunningSessions: value })
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[140px]" aria-label={title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">
            {translate('accounts.claude.switchSessions.settingAsk', 'Ask')}
          </SelectItem>
          <SelectItem value="restart">
            {translate('accounts.claude.switchSessions.settingRestart', 'Always restart')}
          </SelectItem>
          <SelectItem value="keep">
            {translate('accounts.claude.switchSessions.settingKeep', 'Never restart')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
