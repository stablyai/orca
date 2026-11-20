import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type { Translate } from '@/i18n/use-translate'
import { Switch } from '../../../ui/switch'
import { CommitNumberInput } from './commit-number-input'

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
      <CommitNumberInput
        min={50}
        max={99.9}
        allowEmpty
        className="h-6 w-16"
        title={t('accounts.claude.autoSwitch.threshold', 'Switch at % used')}
        placeholder={String(settings.claudeAutoSwitch.threshold)}
        value={rule.threshold}
        onCommit={(threshold) => save({ threshold })}
      />
      <CommitNumberInput
        min={0}
        max={1000}
        allowEmpty
        className="h-6 w-16"
        title={t('accounts.claude.autoSwitch.priority', 'Priority (higher is used first)')}
        placeholder="0"
        value={rule.priority}
        onCommit={(priority) =>
          save({ priority: priority === undefined ? undefined : Math.round(priority) })
        }
      />
    </div>
  )
}
