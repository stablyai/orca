import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_AUTO_UPDATE_COOLDOWN_DAYS,
  MAX_AUTO_UPDATE_COOLDOWN_DAYS,
  MIN_AUTO_UPDATE_COOLDOWN_DAYS
} from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { clampNumber } from '@/lib/terminal-theme'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { SettingsSubsectionHeader } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

type CooldownDraftState = {
  sourceDays: number
  draft: string
}

function getCooldownDaysSetting(settings: GlobalSettings): number {
  return settings.autoUpdateCooldownDays ?? DEFAULT_AUTO_UPDATE_COOLDOWN_DAYS
}

function createCooldownDraftState(days: number): CooldownDraftState {
  return {
    sourceDays: days,
    draft: String(days)
  }
}

function resolveCooldownDraftState(
  state: CooldownDraftState,
  cooldownDays: number
): CooldownDraftState {
  return state.sourceDays === cooldownDays ? state : createCooldownDraftState(cooldownDays)
}

type GeneralUpdateSettingsSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
}

export function GeneralUpdateSettingsSection({
  settings,
  updateSettings
}: GeneralUpdateSettingsSectionProps): React.JSX.Element {
  const updateStatus = useAppStore((s) => s.updateStatus)
  const cooldownDays = getCooldownDaysSetting(settings)
  const [cooldownDraftState, setCooldownDraftState] = useState(() =>
    createCooldownDraftState(cooldownDays)
  )
  const resolvedCooldownDraftState = resolveCooldownDraftState(cooldownDraftState, cooldownDays)
  if (resolvedCooldownDraftState !== cooldownDraftState) {
    // Why: settings may change from another window; keep the visible draft
    // aligned with the persisted value before paint.
    setCooldownDraftState(resolvedCooldownDraftState)
  }
  const cooldownDraft = resolvedCooldownDraftState.draft

  const updateCooldownDraft = (draft: string): void => {
    setCooldownDraftState((current) => ({
      ...resolveCooldownDraftState(current, cooldownDays),
      draft
    }))
  }

  const commitCooldownDraft = (): void => {
    const trimmed = cooldownDraft.trim()
    if (trimmed === '') {
      setCooldownDraftState(createCooldownDraftState(cooldownDays))
      return
    }

    const value = Number(trimmed)
    if (!Number.isFinite(value)) {
      setCooldownDraftState(createCooldownDraftState(cooldownDays))
      return
    }

    const next = clampNumber(
      Math.round(value),
      MIN_AUTO_UPDATE_COOLDOWN_DAYS,
      MAX_AUTO_UPDATE_COOLDOWN_DAYS
    )
    updateSettings({ autoUpdateCooldownDays: next })
    setCooldownDraftState((current) => ({
      ...resolveCooldownDraftState(current, cooldownDays),
      draft: String(next)
    }))
  }

  // Why: the 'error' variant of UpdateStatus does not carry a `version` field.
  // The main process emits `{ state: 'error' }` for both check failures (no
  // version known yet) and download/install failures (version was known from
  // the preceding 'available'/'downloading'/'downloaded' state). Cache the
  // last-known version so the error copy below can distinguish the two cases
  // without adding IPC. Mirrors `versionRef` in UpdateCard.tsx.
  const updateVersionRef = useRef<string | null>(null)
  if (
    (updateStatus.state === 'available' ||
      updateStatus.state === 'downloading' ||
      updateStatus.state === 'downloaded') &&
    updateStatus.version
  ) {
    updateVersionRef.current = updateStatus.version
  } else if (
    updateStatus.state === 'checking' ||
    updateStatus.state === 'idle' ||
    updateStatus.state === 'not-available'
  ) {
    // Why: a new check cycle has started or completed cleanly. Clear the
    // cached version so a subsequent check failure cannot be mis-classified
    // as a download failure based on a stale version from a prior cycle.
    updateVersionRef.current = null
  }

  const [appVersion, setAppVersion] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.api.updater.getVersion().then((version) => {
      if (!cancelled) {
        setAppVersion(version)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const handleRestartToUpdate = (): void => {
    // Why: quitAndInstall resolves immediately (the actual quit happens in a
    // deferred timer in the main process), so rejection here is only possible
    // if the IPC channel itself breaks. Log defensively; the user will notice
    // the app didn't restart and can retry.
    void window.api.updater.quitAndInstall().catch(console.error)
  }

  return (
    <section key="updates" className="space-y-4">
      <SettingsSubsectionHeader
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.f2b1ccc12a',
          'Updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.d91ebfb87e',
          'Current version: {{value0}}',
          { value0: appVersion ?? '...' }
        )}
      />

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.ed46a7cfcf',
          'Update cooldown'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.4c35dc5ec5',
          'Automatic update checks wait this many days after a stable release is published before offering it. Manual checks ignore the cooldown. Set to 0 to disable. Nothing is installed automatically.'
        )}
        keywords={[
          'cooldown',
          'security',
          'supply chain',
          'delay',
          'days',
          'stable',
          'auto update'
        ]}
        className="flex items-center justify-between gap-4 py-2"
      >
        <div className="min-w-0 flex-1 space-y-0.5">
          <Label>
            {translate(
              'auto.components.settings.GeneralUpdateSettingsSection.ed46a7cfcf',
              'Update cooldown'
            )}
          </Label>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.GeneralUpdateSettingsSection.4c35dc5ec5',
              'Automatic update checks wait this many days after a stable release is published before offering it. Manual checks ignore the cooldown. Set to 0 to disable. Nothing is installed automatically.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Input
            type="number"
            min={MIN_AUTO_UPDATE_COOLDOWN_DAYS}
            max={MAX_AUTO_UPDATE_COOLDOWN_DAYS}
            step={1}
            value={cooldownDraft}
            onChange={(event) => updateCooldownDraft(event.target.value)}
            onBlur={commitCooldownDraft}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitCooldownDraft()
              }
            }}
            className="number-input-clean w-20 text-right tabular-nums"
          />
          <span className="text-xs text-muted-foreground">
            {translate('auto.components.settings.GeneralUpdateSettingsSection.62d7b3afec', 'days')}
          </span>
        </div>
      </SearchableSetting>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
          'Check for Updates'
        )}
        description={translate(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['update', 'version', 'release notes', 'download']}
        className="space-y-3"
      >
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            // Why: Shift-click opts this check into the release-candidate
            // channel. Keep the affordance hidden; it's a power-user
            // shortcut, not a discoverable toggle.
            onClick={(event) =>
              window.api.updater.check({
                includePrerelease: event.shiftKey
              })
            }
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
            className="gap-2"
          >
            {updateStatus.state === 'checking' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {translate(
              'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
              'Check for Updates'
            )}
          </Button>

          {updateStatus.state === 'available' ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void window.api.updater.download().catch((error) => {
                  toast.error(
                    translate(
                      'auto.components.settings.GeneralUpdateSettingsSection.02dc082e70',
                      'Could not start the update download.'
                    ),
                    {
                      description: String((error as Error)?.message ?? error)
                    }
                  )
                })
              }}
              className="gap-2"
            >
              <Download className="size-3.5" />
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.42717918f4',
                'Install Update ('
              )}
              {updateStatus.version})
            </Button>
          ) : updateStatus.state === 'downloaded' ? (
            <Button variant="default" size="sm" onClick={handleRestartToUpdate} className="gap-2">
              <Download className="size-3.5" />
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.f44299636f',
                'Restart to Update ('
              )}
              {updateStatus.version})
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          {updateStatus.state === 'idle' &&
            translate(
              'auto.components.settings.GeneralUpdateSettingsSection.d69a09b672',
              'Updates are checked automatically on launch.'
            )}
          {updateStatus.state === 'checking' &&
            translate(
              'auto.components.settings.GeneralUpdateSettingsSection.31fd7150cf',
              'Checking for updates...'
            )}
          {updateStatus.state === 'available' && (
            <>
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc',
                'Version'
              )}
              {updateStatus.version}{' '}
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.8311da27ba',
                'is available. Click "Install Update" to download and install it.'
              )}{' '}
              <a
                href={
                  updateStatus.releaseUrl ??
                  `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                {translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                  'Release notes'
                )}
              </a>
            </>
          )}
          {updateStatus.state === 'not-available' &&
            (updateStatus.heldByCooldown
              ? translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.updateCooldownHeld',
                  'A newer stable release is available but is being held by your update cooldown. Use Check for Updates to install it now.'
                )
              : translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.f40d88390d',
                  'You’re on the latest version.'
                ))}
          {updateStatus.state === 'downloading' &&
            translate(
              'auto.components.settings.GeneralUpdateSettingsSection.2a48034c4c',
              'Downloading v{{value0}}... {{value1}}%',
              { value0: updateStatus.version, value1: updateStatus.percent }
            )}
          {updateStatus.state === 'downloaded' && (
            <>
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc',
                'Version'
              )}
              {updateStatus.version}{' '}
              {translate(
                'auto.components.settings.GeneralUpdateSettingsSection.d89806cc89',
                'is ready to install.'
              )}{' '}
              <a
                href={
                  updateStatus.releaseUrl ??
                  `https://github.com/stablyai/orca/releases/tag/v${updateStatus.version}`
                }
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                {translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                  'Release notes'
                )}
              </a>
            </>
          )}
          {updateStatus.state === 'error' &&
            // Why: `{ state: 'error' }` is emitted for both check-time
            // failures (no version cached) and download/install failures
            // (version cached from a prior 'available'/'downloading'/
            // 'downloaded' state). Label accordingly so a download failure
            // isn't mislabeled as a "check" failure. Mirrors UpdateCard.tsx.
            (updateVersionRef.current
              ? translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.b9ad70c30d',
                  'Update error. {{value0}}',
                  { value0: updateStatus.message }
                )
              : translate(
                  'auto.components.settings.GeneralUpdateSettingsSection.bd79d412f0',
                  'Update check failed. {{value0}}',
                  { value0: updateStatus.message }
                ))}
        </p>
      </SearchableSetting>
    </section>
  )
}
