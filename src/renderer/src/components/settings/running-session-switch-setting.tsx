import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { AccountSwitchRunningSessions } from '../../../../shared/agent-account-switch-settings'
import { ACCOUNT_SWITCH_AGENTS } from '@/lib/agent-account-switch-agents'
import type { AccountRestartAgent } from '@/store/terminals/terminal-contracts'
import { translate } from '@/i18n/i18n'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SearchableSetting } from './SearchableSetting'

const POLICIES: readonly AccountSwitchRunningSessions[] = ['ask', 'restart', 'keep']

function isPolicy(value: string): value is AccountSwitchRunningSessions {
  return POLICIES.some((policy) => policy === value)
}

export function RunningSessionSwitchSetting({
  agent,
  settings,
  updateSettings
}: {
  agent: AccountRestartAgent
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const { copy, settingKey: key } = ACCOUNT_SWITCH_AGENTS[agent]
  const title = copy.settingTitle()
  const description = copy.settingDescription()
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[agent, 'account', 'switch', 'restart', 'running', 'session']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={settings[key] ?? 'ask'}
        onValueChange={(value) => {
          if (isPolicy(value)) {
            updateSettings({ [key]: value })
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[140px]" aria-label={title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">
            {translate('accounts.switchSessions.settingAsk', 'Ask')}
          </SelectItem>
          <SelectItem value="restart">
            {translate('accounts.switchSessions.settingRestart', 'Always restart')}
          </SelectItem>
          <SelectItem value="keep">
            {translate('accounts.switchSessions.settingKeep', 'Never restart')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
