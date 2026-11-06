import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { ClaudeSessionMoverSetting } from '../../../../../../shared/claude-account-switch-settings'
import { translate } from '@/i18n/i18n'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

const SETTINGS: readonly ClaudeSessionMoverSetting[] = ['off', 'ask', 'move']

function isSetting(value: string): value is ClaudeSessionMoverSetting {
  return SETTINGS.some((setting) => setting === value)
}

export function ClaudeSessionMoverSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const title = translate(
    'accounts.claude.sessionMover.settingTitle',
    'Move running sessions before a usage limit'
  )
  const description = translate(
    'accounts.claude.sessionMover.settingDescription',
    'A running Claude session whose own account nears its limit continues on the account with the most room, between turns, in the same pane.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'move', 'session', 'usage', 'limit', 'quota']}
      className="flex items-center justify-between gap-4 py-2"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={settings.claudeSessionMover ?? 'ask'}
        onValueChange={(value) => {
          if (isSetting(value)) {
            updateSettings({ claudeSessionMover: value })
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[140px]" aria-label={title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="off">
            {translate('accounts.claude.sessionMover.settingOff', 'Off')}
          </SelectItem>
          <SelectItem value="ask">
            {translate('accounts.claude.sessionMover.settingAsk', 'Ask')}
          </SelectItem>
          <SelectItem value="move">
            {translate('accounts.claude.sessionMover.settingMove', 'Move')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
