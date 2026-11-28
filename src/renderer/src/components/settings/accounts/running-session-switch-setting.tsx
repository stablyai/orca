import type { ClaudeAccountSwitchRunningSessions } from '../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import { useTranslate } from '@/i18n/use-translate'
import type { AccountSwitchCopy } from '@/lib/provider-accounts/account-switch-copy'
import { Label } from '../../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { SearchableSetting } from '../section-layout/SearchableSetting'

const POLICIES: readonly ClaudeAccountSwitchRunningSessions[] = ['ask', 'restart', 'keep']

function isPolicy(value: string): value is ClaudeAccountSwitchRunningSessions {
  return POLICIES.some((policy) => policy === value)
}

/** What an account switch does with the agent still running in terminals on the old account. */
export function RunningSessionSwitchSetting({
  copy,
  value,
  onChange
}: {
  copy: AccountSwitchCopy
  /** Absent means 'ask'. */
  value: ClaudeAccountSwitchRunningSessions | undefined
  onChange: (value: ClaudeAccountSwitchRunningSessions) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = copy.settingTitle
  const description = copy.settingDescription
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        ...(copy.agent === 'antigravity' ? ['antigravity', 'agy'] : ['claude']),
        'account',
        'switch',
        'restart',
        'running',
        'session'
      ]}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Select
        value={value ?? 'ask'}
        onValueChange={(next) => {
          if (isPolicy(next)) {
            onChange(next)
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
