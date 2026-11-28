import { CLAUDE_ACCOUNT_SWITCH_RUNNING_SESSIONS } from '../../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { ClaudeAccountSwitchRunningSessions } from '../../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../../ui/button'
import { Label } from '../../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import {
  getHostSettingUnsupportedNote,
  getHostSettingUpdateFailedMessage,
  useHostSetting,
  useSettingsHostLabel
} from '../../host-scope/use-host-setting'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

function isPolicy(value: string): value is ClaudeAccountSwitchRunningSessions {
  return CLAUDE_ACCOUNT_SWITCH_RUNNING_SESSIONS.some((policy) => policy === value)
}

export function ClaudeRunningSessionSwitchSetting({
  owner,
  settings,
  updateSettings
}: {
  /** The host whose terminals the switch moves: this app, or the server the pane lists. */
  owner: RuntimeClientTarget
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const hostLabel = useSettingsHostLabel(owner)
  const policy = useHostSetting({
    owner,
    settingKey: 'claudeAccountSwitchRunningSessions',
    localSettings: settings,
    updateLocalSettings: updateSettings,
    updateFailedMessage: getHostSettingUpdateFailedMessage(hostLabel, t)
  })
  const title = t(
    'accounts.claude.switchSessions.settingTitle',
    'When you switch accounts while Claude is running in terminals'
  )
  const description = t(
    'accounts.claude.switchSessions.settingDescription',
    'Restarting continues each terminal conversation on the new account. Busy sessions stop their current work.'
  )
  const value = policy.setting.state === 'ready' ? policy.setting.value : 'ask'
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'switch', 'restart', 'running', 'session']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">
          {policy.setting.state === 'unsupported'
            ? getHostSettingUnsupportedNote(hostLabel, t)
            : policy.setting.state === 'error'
              ? t(
                  'accounts.claude.switchSessions.settingReadFailed',
                  'Couldn’t read this setting from {{host}}.',
                  { host: hostLabel }
                )
              : description}
        </p>
        {policy.setting.state === 'error' ? (
          <Button variant="ghost" size="xs" onClick={policy.retry} className="mt-1">
            {t('accounts.claude.switchSessions.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      <Select
        value={value}
        disabled={policy.setting.state !== 'ready'}
        onValueChange={(next) => {
          if (isPolicy(next)) {
            void policy.update(next)
          }
        }}
      >
        <SelectTrigger size="sm" className="w-[140px]" aria-label={title}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ask">
            {t('accounts.claude.switchSessions.settingAsk', 'Ask')}
          </SelectItem>
          <SelectItem value="restart">
            {t('accounts.claude.switchSessions.settingRestart', 'Always restart')}
          </SelectItem>
          <SelectItem value="keep">
            {t('accounts.claude.switchSessions.settingKeep', 'Never restart')}
          </SelectItem>
        </SelectContent>
      </Select>
    </SearchableSetting>
  )
}
