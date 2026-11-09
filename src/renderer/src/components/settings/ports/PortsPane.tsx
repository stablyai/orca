import { useCallback, useId, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../ui/input'
import { InlineError } from '../../ui/inline-error'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import {
  normalizeRuntimePortForwardSettings,
  type RuntimePortForwardSettings
} from '../../../../../shared/runtime-port-forwards'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'

/** One port box that commits on blur/Enter, clamped to [min, max]; bad input snaps back. */
function PortBox({
  value,
  min,
  max,
  disabled,
  ariaLabel,
  describedBy,
  onCommit,
  onInvalid
}: {
  value: number
  min: number
  max: number
  disabled: boolean
  ariaLabel: string
  describedBy: string
  onCommit: (value: number) => void
  /** Called with the rejected text; null once a value commits. */
  onInvalid: (rejected: string | null) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const [previous, setPrevious] = useState(value)
  if (previous !== value) {
    setPrevious(value)
    setDraft(String(value))
  }
  const parsed = Number(draft.trim())
  const invalid = !Number.isSafeInteger(parsed) || parsed < min || parsed > max
  const commit = (): void => {
    if (invalid) {
      onInvalid(draft)
      setDraft(String(value))
      return
    }
    onInvalid(null)
    if (parsed !== value) {
      onCommit(parsed)
    }
  }
  return (
    <Input
      inputMode="numeric"
      value={draft}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commit()
        }
      }}
      variant="code"
      density="compact"
      className="w-20"
    />
  )
}

/** Settings → Ports: how ports on remote hosts reach this computer's localhost. */
export function PortsPane({ settings }: { settings: GlobalSettings }): React.JSX.Element {
  const t = useTranslate()
  const rangeHelpId = useId()
  const updateSettings = useAppStore((s) => s.updateSettings)
  const forwarding = useMemo(
    () => normalizeRuntimePortForwardSettings(settings.runtimePortForwarding),
    [settings.runtimePortForwarding]
  )
  const update = useCallback(
    (patch: Partial<RuntimePortForwardSettings>) =>
      void updateSettings({
        runtimePortForwarding: normalizeRuntimePortForwardSettings({ ...forwarding, ...patch })
      }),
    [forwarding, updateSettings]
  )
  const off = !forwarding.autoForward
  const [rangeError, setRangeError] = useState<string | null>(null)
  const reportInvalid = useCallback(
    (rejected: string | null) =>
      setRangeError(
        rejected === null
          ? null
          : t(
              'auto.components.settings.ports.rangeInvalid',
              '"{{value0}}" isn\'t a usable port. Use a port from 1 to 65535, lowest first.',
              { value0: rejected }
            )
      ),
    [t]
  )

  return (
    <div className="divide-y divide-border/60">
      <SettingsSwitchRow
        label={t('auto.components.settings.ports.autoForward', 'Auto-forward ports')}
        description={t(
          'auto.components.settings.ports.autoForwardDescription',
          'Forward dev servers on remote hosts to localhost here.'
        )}
        checked={forwarding.autoForward}
        onChange={() => update({ autoForward: !forwarding.autoForward })}
      />
      <SettingsSwitchRow
        label={t('auto.components.settings.ports.exclusive', 'Same port number only')}
        description={t(
          'auto.components.settings.ports.exclusiveDescription',
          'If the port is taken here, skip it instead of remapping.'
        )}
        checked={forwarding.exclusive}
        onChange={() => update({ exclusive: !forwarding.exclusive })}
        disabled={off}
      />
      <SettingsRow
        label={t('auto.components.settings.ports.range', 'Auto-forward port range')}
        description={
          <span id={rangeHelpId}>
            {t(
              'auto.components.settings.ports.rangeDescription',
              "Ports outside this range aren't auto-forwarded."
            )}
          </span>
        }
        control={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <PortBox
              value={forwarding.rangeStart}
              min={1}
              max={forwarding.rangeEnd}
              disabled={off}
              ariaLabel={t('auto.components.settings.ports.rangeStart', 'Lowest port')}
              describedBy={rangeHelpId}
              onCommit={(rangeStart) => update({ rangeStart })}
              onInvalid={reportInvalid}
            />
            <span aria-hidden>–</span>
            <PortBox
              value={forwarding.rangeEnd}
              min={forwarding.rangeStart}
              max={65_535}
              disabled={off}
              ariaLabel={t('auto.components.settings.ports.rangeEnd', 'Highest port')}
              describedBy={rangeHelpId}
              onCommit={(rangeEnd) => update({ rangeEnd })}
              onInvalid={reportInvalid}
            />
          </div>
        }
      />
      {rangeError ? <InlineError title={rangeError} className="my-2" /> : null}
      <SettingsSwitchRow
        label={t('auto.components.settings.ports.notify', 'Notify when a port is forwarded')}
        checked={forwarding.notify}
        onChange={() => update({ notify: !forwarding.notify })}
        disabled={off}
      />
    </div>
  )
}
