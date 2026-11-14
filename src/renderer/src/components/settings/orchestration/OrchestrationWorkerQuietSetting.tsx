import { useId, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  isWorkerQuietMinutes,
  resolveWorkerQuietMinutes
} from '../../../../../shared/orchestration/workers/worker-quiet-settings'
import { useTranslate } from '@/i18n/use-translate'
import { Input } from '../../ui/input'
import { Button } from '../../ui/button'
import { SettingsRow, SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { getWorkerQuietDescription, getWorkerQuietTitle } from './worker-quiet-copy'

type Props = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function OrchestrationWorkerQuietSetting({
  settings,
  updateSettings
}: Props): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const raw = settings.orchestrationQuietWorkerMinutes
  const minutes = resolveWorkerQuietMinutes(settings)
  const chosen = isWorkerQuietMinutes(raw)
  const [draft, setDraft] = useState({ raw, value: String(minutes || 15) })
  const [invalid, setInvalid] = useState(false)
  if (!Object.is(draft.raw, raw)) {
    const draftMinutes = minutes || (isWorkerQuietMinutes(draft.raw) ? draft.raw : 0)
    setDraft({ raw, value: draftMinutes > 0 ? String(draftMinutes) : draft.value })
    setInvalid(false)
  }
  const save = (value: number | null): void => {
    setInvalid(false)
    void updateSettings({ orchestrationQuietWorkerMinutes: value })
  }
  const commit = (): void => {
    const value = Number(draft.value.trim())
    if (!/^\d+$/.test(draft.value.trim()) || !isWorkerQuietMinutes(value) || value === 0) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    if (settings.orchestrationQuietWorkerMinutes !== value) {
      save(value)
    }
  }
  return (
    <SettingsRow
      alignTop
      labelId={id}
      label={getWorkerQuietTitle(t)}
      description={
        <>
          {getWorkerQuietDescription(t)}{' '}
          {chosen
            ? t('auto.components.settings.OrchestrationPane.workerQuietChosen', 'Your choice')
            : t(
                'auto.components.settings.OrchestrationPane.workerQuietDefault',
                'Using default ({{value}})',
                {
                  value: minutes
                    ? t(
                        'auto.components.settings.OrchestrationPane.workerQuietWait',
                        '{{count}} minutes',
                        { count: minutes }
                      )
                    : t('auto.components.settings.OrchestrationPane.workerQuietOff', 'Off')
                }
              )}
          {invalid ? (
            <span id={`${id}-error`} role="alert" className="block text-destructive">
              {t(
                'auto.components.settings.OrchestrationPane.workerQuietInvalid',
                'Enter a whole number of minutes (1 or more).'
              )}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex flex-col items-end gap-2">
          <SettingsSegmentedControl
            value={minutes ? 'after' : 'off'}
            ariaLabelledBy={id}
            options={[
              {
                value: 'off',
                label: t('auto.components.settings.OrchestrationPane.workerQuietOff', 'Off')
              },
              {
                value: 'after',
                label: t('auto.components.settings.OrchestrationPane.workerQuietAfter', 'After')
              }
            ]}
            onChange={(value) => (value === 'off' ? save(0) : commit())}
          />
          <div className="flex items-center gap-2">
            <Input
              type="text"
              inputMode="numeric"
              aria-label={t(
                'auto.components.settings.OrchestrationPane.workerQuietMinutes',
                'Minutes'
              )}
              aria-invalid={invalid}
              aria-describedby={invalid ? `${id}-error` : undefined}
              value={draft.value}
              onChange={(event) => {
                setDraft({ raw, value: event.target.value })
                setInvalid(false)
              }}
              onBlur={() => {
                if (minutes > 0) {
                  commit()
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && minutes > 0) {
                  commit()
                }
              }}
              className="w-24"
            />
            <span className="text-settings-detail text-muted-foreground">
              {t('auto.components.settings.OrchestrationPane.workerQuietUnit', 'minutes')}
            </span>
            <Button variant="ghost" size="sm" disabled={!chosen} onClick={() => save(null)}>
              {t('auto.components.settings.OrchestrationPane.workerQuietReset', 'Use default')}
            </Button>
          </div>
        </div>
      }
    />
  )
}
