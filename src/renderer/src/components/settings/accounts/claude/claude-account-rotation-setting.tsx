import { useEffect, useRef, useState } from 'react'
import {
  resolveClaudeAccountRotationSettings,
  type ClaudeAccountRotationSettings
} from '../../../../../../shared/agent-accounts/claude/claude-account-rotation'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../../ui/select'
import { Switch } from '../../../ui/switch'
import { SettingsRow } from '../../form-controls/SettingsFormControls'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroupNestedRows } from '../../section-layout/SettingsGroup'
import type { AccountsPaneSectionModel } from '../accounts-pane-types'
import {
  ClaudeAccountRotationAccounts,
  type RotationSave
} from './claude-account-rotation-accounts'
import {
  ClaudeAccountRotationStatusLines,
  useClaudeAccountRotationStatus
} from './claude-account-rotation-status'

type SettingProps = Pick<AccountsPaneSectionModel, 'settings' | 'updateSettings'>

function PercentRow({
  id,
  label,
  value,
  onCommit
}: {
  id: string
  label: string
  value: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  // Saved on blur: each keystroke saved would briefly arm a threshold like 9% while typing 90.
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = (): void => {
    const parsed = Number.parseInt(draft, 10)
    if (Number.isNaN(parsed)) {
      setDraft(String(value))
      return
    }
    const next = Math.min(100, Math.max(1, parsed))
    setDraft(String(next))
    if (next !== value) {
      onCommit(next)
    }
  }
  return (
    <SettingsRow
      label={label}
      htmlFor={id}
      control={
        <div className="flex items-center gap-2 tabular-nums">
          <Input
            id={id}
            type="number"
            min={1}
            max={100}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit()
              }
            }}
            className="h-7 w-16 text-center"
          />
          <span className="text-xs text-muted-foreground">%</span>
        </div>
      }
    />
  )
}

export function ClaudeAccountRotationSetting({
  settings,
  updateSettings
}: SettingProps): React.JSX.Element | null {
  const t = useTranslate()
  const rotation = resolveClaudeAccountRotationSettings(settings)
  const status = useClaudeAccountRotationStatus(
    `${JSON.stringify(settings.claudeAccountRotation ?? null)}\0${settings.claudeManagedAccounts.length}`
  )
  // The value of a save still in flight. Settings arrive back only once it lands, so a second
  // change made before then (a threshold blur, then the switch) builds on this instead.
  const pending = useRef<Partial<ClaudeAccountRotationSettings> | null>(null)
  if (!status?.supported) {
    return null
  }
  const save: RotationSave = (change) => {
    const base = pending.current ?? settings.claudeAccountRotation ?? {}
    const current = resolveClaudeAccountRotationSettings({ claudeAccountRotation: base })
    const next = { ...base, ...change(current) }
    pending.current = next
    void Promise.resolve(updateSettings({ claudeAccountRotation: next })).finally(() => {
      if (pending.current === next) {
        pending.current = null
      }
    })
  }
  const title = t('accounts.claude.rotation.title', 'Switch accounts automatically near limits')
  const description = t(
    'accounts.claude.rotation.description',
    'When the selected account nears its 5-hour or weekly limit, Orca gives its folder the login of an account with no running Claude sessions. Running sessions continue on the new login. Accounts on this Mac only.'
  )
  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={['claude', 'account', 'rotation', 'switch', 'limit', 'automatic']}
    >
      <SettingsRow
        label={title}
        description={description}
        htmlFor="claude-account-rotation"
        control={
          <Switch
            id="claude-account-rotation"
            checked={rotation.enabled}
            onCheckedChange={(checked) => save(() => ({ enabled: checked }))}
          />
        }
      />
      {status.externalRotatorActive ? (
        <p className="pb-3 text-settings-detail text-muted-foreground">
          {t(
            'accounts.claude.rotation.externalRotator',
            'Another rotation tool on this Mac (~/.claude/rotate) is on, so Orca leaves the logins alone. Turn that tool off to let Orca switch accounts.'
          )}
        </p>
      ) : null}
      {rotation.enabled ? (
        <SettingsGroupNestedRows>
          <PercentRow
            id="claude-rotation-five-hour"
            label={t('accounts.claude.rotation.fiveHour', 'Switch at 5-hour use')}
            value={rotation.fiveHourPercent}
            onCommit={(value) => save(() => ({ fiveHourPercent: value }))}
          />
          <PercentRow
            id="claude-rotation-weekly"
            label={t('accounts.claude.rotation.weekly', 'Switch at weekly use')}
            value={rotation.weeklyPercent}
            onCommit={(value) => save(() => ({ weeklyPercent: value }))}
          />
          <SettingsRow
            label={t('accounts.claude.rotation.orderTitle', 'Switch to')}
            control={
              <Select
                value={rotation.order}
                onValueChange={(value) =>
                  save(() => ({ order: value === 'reset' ? 'reset' : 'prefer' }))
                }
              >
                <SelectTrigger
                  size="sm"
                  className="w-[220px]"
                  aria-label={t('accounts.claude.rotation.orderTitle', 'Switch to')}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="prefer">
                    {t('accounts.claude.rotation.orderPrefer', 'Highest priority first')}
                  </SelectItem>
                  <SelectItem value="reset">
                    {t('accounts.claude.rotation.orderReset', 'Soonest weekly reset')}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <ClaudeAccountRotationAccounts status={status} rotation={rotation} save={save} />
          <ClaudeAccountRotationStatusLines status={status} />
        </SettingsGroupNestedRows>
      ) : null}
    </SearchableSetting>
  )
}
