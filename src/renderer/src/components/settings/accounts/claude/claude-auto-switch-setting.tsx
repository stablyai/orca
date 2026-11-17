import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { DEFAULT_AUTO_SWITCH_THRESHOLD } from '../../../../../../shared/agent-accounts/claude/claude-account-switch-settings'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../../ui/input'
import { Label } from '../../../ui/label'
import { Switch } from '../../../ui/switch'
import { SearchableSetting } from '../../section-layout/SearchableSetting'

export function clampThreshold(value: number): number {
  return Math.min(99.9, Math.max(50, value))
}

export function ClaudeAutoSwitchSetting({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}): React.JSX.Element {
  const t = useTranslate()
  const title = t('accounts.claude.autoSwitch.title', 'Switch accounts automatically')
  const description = t(
    'accounts.claude.autoSwitch.description',
    'When the active account reaches its limit, switch to the account with the most quota left. Disable or rank accounts in their rows.'
  )
  const auto = settings.claudeAutoSwitch ?? {
    enabled: false,
    threshold: DEFAULT_AUTO_SWITCH_THRESHOLD
  }
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'auto', 'switch', 'rotate', 'limit', 'threshold']}
      className="flex items-center justify-between gap-4 py-3"
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <Label>{title}</Label>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <Input
        type="number"
        min={50}
        max={99.9}
        step={1}
        className="h-7 w-16"
        aria-label={t('accounts.claude.autoSwitch.threshold', 'Switch at % used')}
        value={auto.threshold}
        disabled={!auto.enabled}
        onChange={(event) => {
          const value = Number(event.target.value)
          if (Number.isFinite(value)) {
            updateSettings({ claudeAutoSwitch: { ...auto, threshold: clampThreshold(value) } })
          }
        }}
      />
      <Switch
        checked={auto.enabled}
        aria-label={title}
        onCheckedChange={(enabled) => updateSettings({ claudeAutoSwitch: { ...auto, enabled } })}
      />
    </SearchableSetting>
  )
}
