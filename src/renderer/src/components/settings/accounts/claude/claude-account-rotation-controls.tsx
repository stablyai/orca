import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { Translate } from '@/i18n/use-translate'
import { Input } from '../../../ui/input'
import { Switch } from '../../../ui/switch'
import { clampThreshold } from './claude-auto-switch-setting'

export function ClaudeAccountRotationControls({
  accountId,
  settings,
  updateSettings,
  t
}: {
  accountId: string
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  t: Translate
}): React.JSX.Element | null {
  if (!settings.claudeAutoSwitch?.enabled) {
    return null
  }
  const all = settings.claudeAccountRotation ?? {}
  const rule = all[accountId] ?? {}
  const save = (patch: typeof rule): void =>
    updateSettings({ claudeAccountRotation: { ...all, [accountId]: { ...rule, ...patch } } })
  return (
    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
      <Switch
        checked={!rule.disabled}
        aria-label={t('accounts.claude.autoSwitch.inRotation', 'In rotation')}
        onCheckedChange={(inRotation) => save({ disabled: !inRotation })}
      />
      <Input
        type="number"
        min={50}
        max={99.9}
        className="h-6 w-16"
        title={t('accounts.claude.autoSwitch.threshold', 'Switch at % used')}
        placeholder={String(settings.claudeAutoSwitch.threshold)}
        value={rule.threshold ?? ''}
        onChange={(event) => {
          const value = event.target.value === '' ? undefined : Number(event.target.value)
          save({ threshold: value === undefined ? undefined : clampThreshold(value) })
        }}
      />
      <Input
        type="number"
        min={0}
        max={1000}
        className="h-6 w-16"
        title={t('accounts.claude.autoSwitch.priority', 'Priority (higher is used first)')}
        placeholder="0"
        value={rule.priority ?? ''}
        onChange={(event) => {
          const value = Number(event.target.value)
          save({ priority: Number.isFinite(value) ? Math.min(1000, Math.max(0, value)) : 0 })
        }}
      />
    </div>
  )
}
