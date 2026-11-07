import type React from 'react'
import { useId, useState } from 'react'
import { CircleCheck, Clock, Info, Loader2 } from 'lucide-react'
import { useAppStore } from '../../../store/index'
import { useNow } from '@/hooks/use-now'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { Progress } from '../../ui/progress'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import type { DelayedUpdate, UpdateStatus } from '../../../../../shared/update-status-types'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import {
  isDelayedUpdatePending,
  normalizeUpdateDelayDays,
  UPDATE_DELAY_DAY_OPTIONS
} from '../../../../../shared/update-delay'
import {
  formatUpdateDelayDate,
  getUpdateDelayDescription,
  getUpdateDelayTitle
} from './update-delay-copy'

const MINUTE_MS = 60 * 1000
const DAY_MS = 24 * 60 * MINUTE_MS

// Intl formatter caches key on option identity, so this must be a module constant.
const DAY_UNIT_FORMAT: Intl.NumberFormatOptions = {
  style: 'unit',
  unit: 'day',
  unitDisplay: 'long'
}

function formatDelayDays(days: number): string {
  if (days === 0) {
    return translate('settings.updateDelay.none', 'None')
  }
  // Intl pluralizes and localizes "1 day" / "7 days" without per-locale catalog entries.
  return uiNumberFormat(DAY_UNIT_FORMAT).format(days)
}

// Re-check so the held-release panel reflects the new delay without waiting a day.
function canRecheckAfterDelayChange(status: UpdateStatus): boolean {
  return (
    status.state === 'idle' ||
    status.state === 'checking' ||
    status.state === 'not-available' ||
    status.state === 'available' ||
    status.state === 'error'
  )
}

export function UpdateDelaySetting(): React.JSX.Element {
  const delayDays = useAppStore((s) => normalizeUpdateDelayDays(s.settings?.updateDelayDays))
  const updateSettings = useAppStore((s) => s.updateSettings)
  const updateStatus = useAppStore((s) => s.updateStatus)
  const [lastDelayedUpdate, setLastDelayedUpdate] = useState<DelayedUpdate | undefined>()
  // Keep the panel mounted through re-checks without mutating refs during render.
  const delayedUpdate =
    updateStatus.state === 'checking'
      ? lastDelayedUpdate
      : updateStatus.state === 'not-available'
        ? updateStatus.delayedUpdate
        : undefined
  if (delayedUpdate !== lastDelayedUpdate) {
    setLastDelayedUpdate(delayedUpdate)
  }
  const checking = updateStatus.state === 'checking'
  const now = useNow(MINUTE_MS, Boolean(delayedUpdate))
  const labelId = useId()
  const descriptionId = useId()
  const title = getUpdateDelayTitle()
  const description = getUpdateDelayDescription()
  const options = UPDATE_DELAY_DAY_OPTIONS.includes(delayDays)
    ? UPDATE_DELAY_DAY_OPTIONS
    : [...UPDATE_DELAY_DAY_OPTIONS, delayDays].sort((a, b) => a - b)

  const setDelayDays = (next: number): void => {
    if (next === delayDays) {
      return
    }
    const shouldRecheck = canRecheckAfterDelayChange(updateStatus)
    void updateSettings({ updateDelayDays: next }).then(() => {
      if (shouldRecheck) {
        void window.api.updater.check({ ignoreUpdateDelay: false })
      }
    })
  }

  return (
    <SearchableSetting
      title={title}
      description={description}
      keywords={[
        'update',
        'delay',
        'cooldown',
        'defer',
        'wait',
        'stable',
        'security',
        'supply chain'
      ]}
      className="space-y-3"
    >
      <div className="space-y-2">
        <div className="flex items-center gap-1.5">
          <Label id={labelId}>{title}</Label>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={translate('settings.updateDelay.info', 'About Update Delay')}
              >
                <Info className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4} className="max-w-xs">
              {description}
            </TooltipContent>
          </Tooltip>
          <span id={descriptionId} className="sr-only">
            {description}
          </span>
        </div>
        <SettingsSegmentedControl
          value={delayDays}
          onChange={setDelayDays}
          ariaLabelledBy={labelId}
          ariaDescribedBy={descriptionId}
          size="sm"
          wrap
          options={options.map((days) => ({ value: days, label: formatDelayDays(days) }))}
        />
      </div>
      {delayedUpdate ? (
        <DelayedUpdatePanel
          delayedUpdate={delayedUpdate}
          now={now}
          checking={checking}
          onSkipDelayOnce={() => void window.api.updater.check({ ignoreUpdateDelay: true })}
        />
      ) : null}
    </SearchableSetting>
  )
}

type DelayedUpdatePanelProps = {
  delayedUpdate: DelayedUpdate
  now: number
  checking: boolean
  onSkipDelayOnce: () => void
}

export function DelayedUpdatePanel({
  delayedUpdate,
  now,
  checking,
  onSkipDelayOnce
}: DelayedUpdatePanelProps): React.JSX.Element {
  const releasedAt = Date.parse(delayedUpdate.releasedAt)
  const availableAt = Date.parse(delayedUpdate.availableAt)
  const total = Math.max(availableAt - releasedAt, 1)
  const percent = Math.min(100, Math.max(0, ((now - releasedAt) / total) * 100))
  const cleared = !isDelayedUpdatePending(delayedUpdate, now)
  // Absolute release dates avoid rounding clashes like "3 days ago" against a 3-day delay.
  const released = formatUpdateDelayDate(releasedAt)
  const relative = formatUiRelativeTime(availableAt - now)
  const availableLabel =
    availableAt - now < DAY_MS
      ? translate('settings.updateDelay.availableSoon', 'Available to you {{relative}}', {
          relative
        })
      : translate('settings.updateDelay.availableOn', 'Available to you {{date}} ({{relative}})', {
          date: formatUpdateDelayDate(availableAt),
          relative
        })
  const Icon = cleared ? CircleCheck : Clock
  return (
    <div className="flex max-w-md gap-3 rounded-md border border-border bg-muted/30 p-3">
      <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="space-y-0.5">
          <p className="text-xs font-medium text-foreground">
            {cleared
              ? translate('settings.updateDelay.clearedTitle', 'Orca {{version}} is ready', {
                  version: delayedUpdate.version
                })
              : translate('settings.updateDelay.heldTitle', 'Orca {{version}} is on hold', {
                  version: delayedUpdate.version
                })}
          </p>
          <p className="text-pretty text-xs text-muted-foreground">
            {translate('settings.updateDelay.released', 'Released {{released}}', { released })}
            {cleared ? null : ` · ${availableLabel}`}
          </p>
        </div>
        {cleared ? null : (
          <Progress
            value={percent}
            getValueLabel={() => availableLabel}
            className="h-1"
            aria-label={translate(
              'settings.updateDelay.progress',
              'Time until Orca {{version}} is available',
              { version: delayedUpdate.version }
            )}
          />
        )}
        <div className="flex items-center gap-3">
          {cleared ? null : (
            <Button
              variant="outline"
              size="xs"
              onClick={onSkipDelayOnce}
              disabled={checking}
              title={translate(
                'settings.updateDelay.skipDelayOnceHint',
                'Check for this release now. Your delay setting stays the same.'
              )}
            >
              {checking ? <Loader2 className="animate-spin" /> : null}
              {translate('settings.updateDelay.skipDelayOnce', 'Skip Delay Once')}
            </Button>
          )}
          <a
            href={getReleaseNotesUrlForVersion(delayedUpdate.version)}
            target="_blank"
            onClick={openAppHttpLinkFromAnchor}
            rel="noopener noreferrer"
            className="text-xs text-muted-foreground underline hover:text-foreground"
          >
            {translate(
              'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
              'Release notes'
            )}
          </a>
        </div>
      </div>
    </div>
  )
}
