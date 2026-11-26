import type React from 'react'
import { useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
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

type UpdateStatusRowProps = {
  model: UpdateStatusRowModel
  status: UpdateStatus
  appVersion: string | null
  iconUrl: string
  onDownload: () => void
  onRestart: () => void
}

/** Full and narrow copy for one line; the narrow form shows when the card is under 20rem. */
type LineCopy = { full: string; narrow?: string; tone?: 'destructive' }

function lineCopy(line: UpdateStatusLine, t: Translate, intlLocale: string): LineCopy | null {
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
        narrow: t('settings.about.status.held', '{{version}} on hold', { version: line.version })
      }
    case 'held-ready':
    case 'available':
      return {
        full: t('settings.about.status.available', '{{version}} available', {
          version: line.version
        }),
        narrow: line.version
      }
    case 'unsupported-system':
      return { full: t('settings.about.status.latestForMac', 'Latest for this Mac') }
    case 'downloading':
      return {
        full: t('settings.about.status.downloading', 'Downloading {{version}}', {
          version: line.version
        }),
        narrow: line.version
      }
    case 'ready':
      return {
        full: t('settings.about.status.ready', '{{version}} ready', { version: line.version }),
        narrow: line.version
      }
    case 'installing':
      return {
        full: t('settings.about.status.installing', 'Installing {{version}}…', {
          version: line.version
        }),
        narrow: line.version
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
  const percent = model.line.kind === 'downloading' ? Math.round(model.line.percent) : null

  return (
    <div className="@container/about-status">
      <div className="flex items-center gap-3">
        <img src={iconUrl} alt="" aria-hidden className="size-7 shrink-0 rounded-md" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">
            {t('settings.general.about.version', 'Orca {{version}}', {
              version: appVersion ?? '…'
            })}
          </div>
          {copy || details ? (
            <div
              role="status"
              className="flex min-w-0 items-center whitespace-nowrap text-settings-detail text-muted-foreground"
            >
              {copy ? (
                <span
                  className={cn(
                    'min-w-0 truncate',
                    copy.tone === 'destructive' && 'text-destructive'
                  )}
                >
                  <span className={cn(copy.narrow && '@max-xs/about-status:hidden')}>
                    {copy.full}
                  </span>
                  {copy.narrow ? (
                    <span className="hidden @max-xs/about-status:inline">{copy.narrow}</span>
                  ) : null}
                </span>
              ) : null}
              {model.notesVersion ? (
                <>
                  <span aria-hidden className="px-1.5">
                    ·
                  </span>
                  <a
                    href={releaseNotesUrl(status, model.notesVersion)}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={openAppHttpLinkFromAnchor}
                    className="shrink-0 hover:text-foreground hover:underline"
                  >
                    {t('settings.about.status.notes', 'Notes')}
                  </a>
                </>
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
            </div>
          ) : null}
        </div>
        <UpdateStatusAction
          model={model}
          percent={percent}
          onDownload={onDownload}
          onRestart={onRestart}
        />
      </div>
      {percent !== null ? (
        <div className="mt-2 ms-10">
          <Progress
            value={percent}
            aria-label={t('settings.about.status.downloadProgress', 'Download progress')}
            className="h-1"
          />
        </div>
      ) : null}
      {showDetails ? <UpdateStatusDetails text={details} /> : null}
    </div>
  )
}

function UpdateStatusDetails({ text }: { text: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="mt-2 ms-10 flex items-start gap-1 rounded-md bg-muted/50 py-1.5 ps-2.5 pe-1">
      <pre className="max-h-24 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-all py-0.5 font-mono text-xs text-muted-foreground scrollbar-sleek">
        {text}
      </pre>
      <Button
        type="button"
        variant="ghost-muted"
        size="icon-xs"
        aria-label={t('settings.about.status.copyDetails', 'Copy details')}
        onClick={() => {
          void window.api.ui.writeClipboardText(text).then(
            () => toast.message(t('settings.about.status.copied', 'Copied')),
            () => toast.error(t('settings.about.status.copyFailed', 'Could not copy details.'))
          )
        }}
      >
        <Copy />
      </Button>
    </div>
  )
}

function UpdateStatusAction({
  model,
  percent,
  onDownload,
  onRestart
}: {
  model: UpdateStatusRowModel
  percent: number | null
  onDownload: () => void
  onRestart: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const { kind, busy, disabled } = model.action
  const spinner = busy ? <Loader2 className="animate-spin" /> : null
  switch (kind) {
    case 'none':
      return null
    case 'progress':
      return (
        <span className="shrink-0 text-sm text-muted-foreground tabular-nums">{percent ?? 0}%</span>
      )
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
          {spinner}
          {kind === 'check'
            ? t('settings.about.action.check', 'Check')
            : t('settings.about.action.retry', 'Retry')}
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
          onClick={() => void window.api.updater.check({ ignoreUpdateDelay: true })}
        >
          {t('settings.about.action.skipDelay', 'Skip delay')}
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
