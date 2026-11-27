import type React from 'react'
import { useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { uiNumberFormat } from '@/i18n/ui-intl-formatters'
import { useIntlLocale, useTranslate, type Translate } from '@/i18n/use-translate'
import { updaterMessageText } from '@/app-shell/updates/updater-message-copy'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'
import { cn } from '@/lib/class-names'
import { getUpdateInstallBlockGuidance } from '../../maintenance/update-card/update-install-block-guidance'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/updater/release-channel'
import type { UpdateStatus } from '../../../../../shared/updater/update-status-types'
import { formatUpdateDelayDate } from './update-delay-copy'
import type { UpdateStatusLine, UpdateStatusRowModel } from './update-status-row-model'
import { UpdateStatusDetails } from './UpdateStatusDetails'

// Intl formatter caches key on option identity, so this must be a module constant.
const PERCENT_FORMAT: Intl.NumberFormatOptions = { style: 'percent', maximumFractionDigits: 0 }

type UpdateStatusRowProps = {
  model: UpdateStatusRowModel
  status: UpdateStatus
  appVersion: string | null
  iconUrl: string
  onDownload: () => void
  onRestart: () => void
}

/** Full and narrow copy for one line; the narrow form shows when the card is under 20rem and never drops a version. */
type LineCopy = { full: string; narrow?: string; tone?: 'destructive' }

function lineCopy(line: UpdateStatusLine, t: Translate, intlLocale: string): LineCopy | null {
  const percent = (value: number): string =>
    uiNumberFormat(PERCENT_FORMAT, intlLocale).format(Math.round(value) / 100)
  switch (line.kind) {
    case 'none':
      return null
    case 'checking':
      return { full: t('settings.about.status.checking', 'Checking…') }
    case 'up-to-date':
      return { full: t('settings.about.status.upToDate', 'Up to date') }
    case 'held':
      return {
        full: t('settings.about.status.heldUntil', '{{version}} on hold until {{date}}', {
          version: line.version,
          date: formatUpdateDelayDate(line.availableAt, intlLocale)
        }),
        // Short enough to sit beside Notes on the 256px card; the full status stays readable to
        // screen readers.
        narrow: t('settings.about.status.heldNarrow', '{{version}} held · {{date}}', {
          version: line.version,
          date: formatUpdateDelayDate(line.availableAt, intlLocale, true)
        })
      }
    case 'held-ready':
    case 'available':
      return {
        full: t('settings.about.status.available', '{{version}} available', {
          version: line.version
        })
      }
    case 'unsupported-system':
      return { full: t('settings.about.status.latestForMac', 'Latest for this Mac') }
    case 'downloading':
      return {
        full: t('settings.about.status.downloadingPercent', 'Downloading {{percent}}', {
          percent: percent(line.percent)
        })
      }
    case 'ready':
      return {
        full: t('settings.about.status.ready', '{{version}} ready', { version: line.version })
      }
    case 'installing':
      return {
        full: t('settings.about.status.installing', 'Installing {{version}}…', {
          version: line.version
        })
      }
    case 'install-on-quit':
      return { full: t('settings.about.status.installOnQuit', 'Quit to install') }
    case 'install-blocked':
      return {
        full: t('settings.about.status.installBlocked', 'Install blocked'),
        tone: 'destructive'
      }
    case 'failed':
      return {
        full:
          line.phase === 'update'
            ? t('settings.about.status.updateFailed', 'Update failed')
            : t('settings.about.status.checkFailed', 'Check failed'),
        narrow: t('settings.about.status.failed', 'Failed'),
        tone: 'destructive'
      }
  }
}

function detailsText(
  model: UpdateStatusRowModel,
  status: UpdateStatus,
  t: Translate
): string | null {
  switch (model.details) {
    case null:
      return null
    case 'message':
      return status.state === 'error' ? updaterMessageText(status) : null
    case 'install-block': {
      if (status.state !== 'error' || !status.installBlock) {
        return null
      }
      const guidance = getUpdateInstallBlockGuidance(status.installBlock, t)
      return `${guidance.summary} ${guidance.explainer}`
    }
    case 'unsupported-system':
      return status.state === 'not-available' && status.unsupportedSystemUpdate
        ? t(
            'macosUpdateRequirement.settingsStatus',
            'Orca {{version}} requires macOS {{macos}} or later. This is the latest version for this Mac.',
            {
              version: status.unsupportedSystemUpdate.version,
              macos: status.unsupportedSystemUpdate.minimumMacosVersion
            }
          )
        : null
    case 'externally-managed':
      return status.state === 'available'
        ? t(
            'auto.components.settings.GeneralUpdateSettingsSection.externallyManagedVersionAvailable',
            'Version {{version}} is available. Update Orca through your system package manager — Orca cannot install this release itself.',
            { version: status.version }
          )
        : null
  }
}

function releaseNotesUrl(status: UpdateStatus, version: string): string {
  const url = 'releaseUrl' in status ? status.releaseUrl : undefined
  return url ?? getReleaseNotesUrlForVersion(version)
}

/** Dev builds carry a long build suffix; the semver must stay whole, so only the suffix truncates. */
function splitVersion(version: string | null): { semver: string; suffix: string } {
  if (!version) {
    return { semver: '…', suffix: '' }
  }
  const dash = version.indexOf('-')
  return dash === -1
    ? { semver: version, suffix: '' }
    : { semver: version.slice(0, dash), suffix: version.slice(dash) }
}

export function UpdateStatusRow({
  model,
  status,
  appVersion,
  iconUrl,
  onDownload,
  onRestart
}: UpdateStatusRowProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const [detailsOpen, setDetailsOpen] = useState(false)
  const copy = lineCopy(model.line, t, intlLocale)
  const details = detailsText(model, status, t)
  const showDetails = detailsOpen && details !== null
  const version = splitVersion(appVersion)
  const hasAction =
    model.secondaryCheck || (model.action.kind !== 'none' && model.action.kind !== 'progress')
  const hasNotes = Boolean(model.notesVersion)

  return (
    <div className="@container/about-status">
      <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3">
        <img
          src={iconUrl}
          alt=""
          aria-hidden
          className="col-start-1 row-start-1 row-end-3 size-7 rounded-md"
        />
        <div
          title={version.suffix ? (appVersion ?? undefined) : undefined}
          className={cn(
            'col-start-2 row-start-1 flex min-w-0 text-sm font-medium',
            !hasAction && 'col-end-4'
          )}
        >
          <span className="shrink-0">
            {t('settings.general.about.version', 'Orca {{version}}', { version: version.semver })}
          </span>
          {version.suffix ? <span className="min-w-0 truncate">{version.suffix}</span> : null}
        </div>
        <div
          className={cn(
            'col-start-2 row-start-2 min-w-0 self-start',
            !hasAction && 'col-end-4',
            hasNotes && '@max-xs/about-status:col-end-4'
          )}
        >
          {/* The live region stays mounted, empty when idle, so state changes are announced. */}
          <div className="flex min-w-0 items-center whitespace-nowrap text-settings-detail text-muted-foreground">
            <span
              role="status"
              className={cn('min-w-0 truncate', copy?.tone === 'destructive' && 'text-destructive')}
            >
              {copy ? (
                <>
                  {/* When narrow, the full copy stays in the accessibility tree; the short form is visual only. */}
                  <span className={cn(copy.narrow && '@max-xs/about-status:sr-only')}>
                    {copy.full}
                  </span>
                  {copy.narrow ? (
                    <span aria-hidden className="hidden @max-xs/about-status:inline">
                      {copy.narrow}
                    </span>
                  ) : null}
                </>
              ) : null}
            </span>
            {copy || details ? (
              <>
                {model.notesVersion ? (
                  <span className="shrink-0">
                    <span aria-hidden className="px-1.5">
                      ·
                    </span>
                    <a
                      href={releaseNotesUrl(status, model.notesVersion)}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={openAppHttpLinkFromAnchor}
                      className="hover:text-foreground hover:underline"
                    >
                      {t('settings.about.status.notes', 'Notes')}
                    </a>
                  </span>
                ) : null}
                {details ? (
                  <>
                    {copy ? (
                      <span aria-hidden className="px-1.5">
                        ·
                      </span>
                    ) : null}
                    <Button
                      type="button"
                      variant="link-muted"
                      size="inlineInherit"
                      aria-expanded={showDetails}
                      onClick={() => setDetailsOpen((open) => !open)}
                    >
                      <span className="@max-xs/about-status:hidden">
                        {showDetails
                          ? t('settings.about.status.hideDetails', 'Hide details')
                          : t('settings.about.status.showDetails', 'Show details')}
                      </span>
                      <span className="hidden @max-xs/about-status:inline">
                        {showDetails
                          ? t('settings.about.status.hide', 'Hide')
                          : t('settings.about.status.details', 'Details')}
                      </span>
                    </Button>
                  </>
                ) : null}
              </>
            ) : null}
          </div>
        </div>
        {hasAction ? (
          <div
            className={cn(
              'col-start-3 row-start-1 row-end-3 flex items-center gap-3',
              hasNotes && '@max-xs/about-status:row-end-2'
            )}
          >
            {model.secondaryCheck ? (
              <span className="@max-xs/about-status:hidden">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost-muted"
                      size="icon-sm"
                      aria-label={t('settings.about.action.checkForUpdates', 'Check for updates')}
                      disabled={model.secondaryCheck.disabled}
                      // Modifier clicks pick a one-off release track, not a saved setting.
                      onClick={(event) =>
                        void window.api.updater.check(getUpdateCheckClickOptions(event))
                      }
                    >
                      <RefreshCw />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top" sideOffset={4} className="max-w-xs">
                    {t('settings.about.action.checkForUpdates', 'Check for updates')}
                    <span className="block text-muted-foreground">{getUpdateCheckHint()}</span>
                  </TooltipContent>
                </Tooltip>
              </span>
            ) : null}
            <UpdateStatusAction model={model} onDownload={onDownload} onRestart={onRestart} />
          </div>
        ) : null}
      </div>
      {showDetails ? <UpdateStatusDetails text={details} /> : null}
    </div>
  )
}

function UpdateStatusAction({
  model,
  onDownload,
  onRestart
}: {
  model: UpdateStatusRowModel
  onDownload: () => void
  onRestart: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { kind, busy, disabled } = model.action
  const spinner = busy ? <Loader2 className="animate-spin" /> : null
  switch (kind) {
    case 'none':
    case 'progress':
      // Download progress lives in the state line; the app-wide update card owns the bar.
      return null
    case 'check':
    case 'retry-check':
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          title={getUpdateCheckHint()}
          // Modifier clicks pick a one-off release track, not a saved setting.
          onClick={(event) => void window.api.updater.check(getUpdateCheckClickOptions(event))}
        >
          <span className="relative inline-grid place-items-center">
            <span className={busy ? 'opacity-0' : undefined}>
              {kind === 'check'
                ? t('settings.about.action.check', 'Check')
                : t('settings.about.action.retry', 'Retry')}
            </span>
            {busy ? <Loader2 aria-hidden className="absolute animate-spin" /> : null}
          </span>
        </Button>
      )
    case 'skip-delay':
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          title={t(
            'settings.updateDelay.skipDelayOnceHint',
            'Check for this release now. Your delay setting stays the same.'
          )}
          aria-label={t('settings.about.action.skipDelay', 'Skip delay')}
          onClick={() => void window.api.updater.check({ ignoreUpdateDelay: true })}
        >
          <span className="@max-xs/about-status:hidden">
            {t('settings.about.action.skipDelay', 'Skip delay')}
          </span>
          <span className="hidden @max-xs/about-status:inline">
            {t('settings.about.action.skip', 'Skip')}
          </span>
        </Button>
      )
    case 'download':
      return (
        <Button type="button" size="sm" onClick={onDownload}>
          {t('settings.about.action.update', 'Update')}
        </Button>
      )
    case 'restart':
      return (
        <Button type="button" size="sm" disabled={disabled} onClick={onRestart}>
          {spinner}
          {t('settings.about.action.restart', 'Restart')}
        </Button>
      )
    case 'retry-install':
      return (
        <Button type="button" variant="outline" size="sm" onClick={onRestart}>
          {t('settings.about.action.retry', 'Retry')}
        </Button>
      )
    case 'quit':
      return (
        <Button
          type="button"
          size="sm"
          onClick={() => void window.api.app.quit().catch(console.error)}
        >
          {t('updates.installOnQuit.quit', 'Quit Orca')}
        </Button>
      )
  }
}
