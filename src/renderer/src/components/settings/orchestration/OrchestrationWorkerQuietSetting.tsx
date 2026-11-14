import { useId, useState } from 'react'
import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import {
  isWorkerQuietMinutes,
  MAX_WORKER_QUIET_MINUTES,
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

export function OrchestrationWorkerQuietSetting(props: Props): React.JSX.Element {
  return (
    <WorkerQuietControl key={String(props.settings.orchestrationQuietWorkerMinutes)} {...props} />
  )
}

function WorkerQuietControl({ settings, updateSettings }: Props): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const minutes = resolveWorkerQuietMinutes(settings)
  const chosen = isWorkerQuietMinutes(settings.orchestrationQuietWorkerMinutes)
  const [draft, setDraft] = useState(String(minutes || 15))
  const [invalid, setInvalid] = useState(false)
  const save = (value: number | null): void => {
    void updateSettings({ orchestrationQuietWorkerMinutes: value })
  }
  const commit = (): void => {
    const value = Number(draft.trim())
    if (!/^\d+$/.test(draft.trim()) || !isWorkerQuietMinutes(value) || value === 0) {
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
                'Enter a whole number of minutes between 1 and {{max}}.',
                { max: MAX_WORKER_QUIET_MINUTES }
              )}
            </span>
          ) : null}
        </>
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-2">
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
          <Input
            type="text"
            inputMode="numeric"
            aria-label={t(
              'auto.components.settings.OrchestrationPane.workerQuietMinutes',
              'Minutes'
            )}
            aria-invalid={invalid}
            aria-describedby={invalid ? `${id}-error` : undefined}
            value={draft}
            disabled={minutes === 0}
            onChange={(event) => {
              setDraft(event.target.value)
              setInvalid(false)
            }}
            onBlur={() => {
              if (minutes > 0) {
                commit()
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commit()
              }
            }}
            className="w-24"
          />
          <span className="text-xs text-muted-foreground">
            {t('auto.components.settings.OrchestrationPane.workerQuietUnit', 'minutes')}
          </span>
          <Button variant="ghost" size="sm" disabled={!chosen} onClick={() => save(null)}>
            {t('auto.components.settings.OrchestrationPane.workerQuietReset', 'Use default')}
          </Button>
        </div>
      }
    />
  )
}
