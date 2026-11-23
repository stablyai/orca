import { getUpdateInstallBlockGuidance } from '../../maintenance/update-card/update-install-block-guidance'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { Button } from '../../ui/button'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { updaterMessageText } from '@/app-shell/updates/updater-message-copy'
import {
  getUpdateCheckClickOptions,
  getUpdateCheckHint
} from '@/app-shell/updates/update-check-click-options'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import { UpdateDelaySetting } from './UpdateDelaySetting'
import { AutomaticUpdatesSetting } from './AutomaticUpdatesSetting'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { formatUpdateDelayDate } from './update-delay-copy'
import { useNow } from '@/lib/window-activity/use-now'
import { isDelayedUpdatePending } from '../../../../../shared/updater/update-delay'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/updater/release-channel'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'

export function GeneralUpdateSettingsSection({
  children
}: { children?: React.ReactNode } = {}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const updateStatus = useAppStore((s) => s.updateStatus)
  // Older hosts omit error versions; retain the target for accurate failure copy.
  const updateVersionRef = useRef<string | null>(null)
  if ('version' in updateStatus && updateStatus.version) {
    updateVersionRef.current = updateStatus.version
  } else if (
    updateStatus.state === 'checking' ||
    updateStatus.state === 'idle' ||
    updateStatus.state === 'not-available'
  ) {
    // Clear old targets on clean/new cycles so later check failures cannot look like stale download failures.
    updateVersionRef.current = null
  }

  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [failedRestartStatus, setFailedRestartStatus] = useState<typeof updateStatus | null>(null)
  const stagedQuitVersion =
    updateStatus.installOnQuit &&
    (updateStatus.state === 'error' ||
      (updateStatus.state === 'downloaded' && failedRestartStatus === updateStatus))
      ? updateStatus.version
      : undefined
  const quitToInstall = window.api.updater.quitToInstallStagedUpdate
  const now = useNow(
    60_000,
    updateStatus.state === 'not-available' && Boolean(updateStatus.delayedUpdate)
  )
  const updateCheckHint = getUpdateCheckHint()
  // Hide channel switching behind Option/Alt-click because it can downgrade to unvetted builds.
  const [channelSwitcherRevealed, setChannelSwitcherRevealed] = useState(false)

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
    void window.api.updater.quitAndInstall().catch((error: unknown) => {
      setFailedRestartStatus(updateStatus)
      if (!updateStatus.installOnQuit) {
        toast.error(
          t(
            'auto.components.UpdateCard.restartToInstallFailed',
            'Could not restart to install the update.'
          ),
          { description: error instanceof Error ? error.message : String(error) }
        )
      }
    })
  }

  return (
    <SettingsGroup
      key="updates"
      title={t('settings.general.about.title', 'About')}
      onHeaderClick={(event) => {
        if (event.altKey) {
          setChannelSwitcherRevealed((revealed) => !revealed)
        }
      }}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralUpdateSettingsSection.6d27bd46e3',
          'Check for updates'
        )}
        description={t(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['about', 'update', 'version', 'release notes', 'download']}
        className="space-y-3 py-3"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="text-sm">
            {t('settings.general.about.version', 'Orca {{version}}', {
              version: appVersion ?? '…'
            })}
          </span>
          <Button
            variant="outline"
            size="sm"
            // Modifier clicks are one-off update actions, not saved toggles.
            onClick={(event) => window.api.updater.check(getUpdateCheckClickOptions(event))}
            title={updateCheckHint}
            disabled={
              updateStatus.state === 'checking' ||
              updateStatus.state === 'downloading' ||
              (updateStatus.state === 'error' &&
                updateStatus.messageCode === 'macStagingTimeout') ||
              (updateStatus.state === 'downloaded' && updateStatus.installing)
            }
            className="gap-2"
          >
            {updateStatus.state === 'checking' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t(
              'auto.components.settings.GeneralUpdateSettingsSection.6d27bd46e3',
              'Check for updates'
            )}
          </Button>

          {stagedQuitVersion && quitToInstall ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void quitToInstall(stagedQuitVersion).catch((error: unknown) =>
                  toast.error(t('updates.installOnQuit.quitFailed', 'Could not quit Orca.'), {
                    description: error instanceof Error ? error.message : String(error)
                  })
                )
              }}
            >
              {t('updates.installOnQuit.quit', 'Quit Orca')}
            </Button>
          ) : updateStatus.state === 'available' && !updateStatus.externallyManaged ? (
            <Button
              variant="default"
              size="sm"
              onClick={() => {
                void window.api.updater.download().catch((error) => {
                  toast.error(
                    t(
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
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.downloadUpdate',
                'Download update'
              )}
            </Button>
          ) : updateStatus.state === 'error' &&
            updateStatus.retryAction === 'install' &&
            updateStatus.retryable !== false ? (
            <Button variant="default" size="sm" onClick={handleRestartToUpdate} className="gap-2">
              <RefreshCw className="size-3.5" />
              {t('auto.components.UpdateCard.b3b02a9d84', 'Try again')}
            </Button>
          ) : updateStatus.state === 'downloaded' &&
            !(updateStatus.automaticDownload && updateStatus.installing) ? (
            <Button
              variant="default"
              size="sm"
              onClick={handleRestartToUpdate}
              disabled={updateStatus.installing}
              className="gap-2"
            >
              <Download className="size-3.5" />
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.restartToUpdate',
                'Restart to update'
              )}
            </Button>
          ) : null}
        </div>

        <p className="text-xs text-muted-foreground">
          {updateStatus.state === 'idle' &&
            t(
              'auto.components.settings.GeneralUpdateSettingsSection.d69a09b672',
              'Updates are checked automatically on launch.'
            )}
          {updateStatus.state === 'checking' &&
            t(
              'auto.components.settings.GeneralUpdateSettingsSection.31fd7150cf',
              'Checking for updates...'
            )}
          {updateStatus.state === 'available' && (
            <>
              {updateStatus.externallyManaged
                ? t(
                    'auto.components.settings.GeneralUpdateSettingsSection.externallyManagedVersionAvailable',
                    'Version {{version}} is available. Update Orca through your system package manager — Orca cannot install this release itself.',
                    { version: updateStatus.version }
                  )
                : t(
                    'auto.components.settings.GeneralUpdateSettingsSection.versionAvailable',
                    'Version {{version}} is available.',
                    { version: updateStatus.version }
                  )}
              {updateStatus.source !== 'local' && (
                <a
                  href={
                    updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)
                  }
                  target="_blank"
                  onClick={openAppHttpLinkFromAnchor}
                  rel="noopener noreferrer"
                  className="ms-1 whitespace-nowrap underline hover:text-foreground"
                >
                  {t(
                    'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                    'Release notes'
                  )}
                </a>
              )}
            </>
          )}
          {updateStatus.state === 'not-available' &&
            (updateStatus.unsupportedSystemUpdate
              ? t(
                  'macosUpdateRequirement.settingsStatus',
                  'Orca {{version}} requires macOS {{macos}} or later. This is the latest version for this Mac.',
                  {
                    version: updateStatus.unsupportedSystemUpdate.version,
                    macos: updateStatus.unsupportedSystemUpdate.minimumMacosVersion
                  }
                )
              : updateStatus.delayedUpdate
                ? isDelayedUpdatePending(updateStatus.delayedUpdate, now)
                  ? t(
                      'settings.updateDelay.upToDateWithHeld',
                      'You’re up to date. A newer release is on hold until {{date}}.',
                      {
                        date: formatUpdateDelayDate(
                          Date.parse(updateStatus.delayedUpdate.availableAt),
                          intlLocale
                        )
                      }
                    )
                  : t(
                      'settings.updateDelay.heldReleaseReady',
                      'A newer release is ready. Check for updates to get it.'
                    )
                : t(
                    'auto.components.settings.GeneralUpdateSettingsSection.f40d88390d',
                    'You’re on the latest version.'
                  ))}
          {updateStatus.state === 'downloading' &&
            t(
              'auto.components.settings.GeneralUpdateSettingsSection.downloadingVersion',
              'Downloading version {{version}} ({{percent}}%)…',
              { version: updateStatus.version, percent: updateStatus.percent }
            )}
          {updateStatus.state === 'downloaded' && !stagedQuitVersion && (
            <>
              {updateStatus.installing
                ? t(
                    'auto.components.settings.GeneralUpdateSettingsSection.versionInstalling',
                    'Version {{version}} is being installed.',
                    { version: updateStatus.version }
                  )
                : t(
                    'auto.components.settings.GeneralUpdateSettingsSection.versionReadyToInstall',
                    'Version {{version}} is ready to install.',
                    { version: updateStatus.version }
                  )}
              {updateStatus.source !== 'local' && (
                <a
                  href={
                    updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)
                  }
                  target="_blank"
                  onClick={openAppHttpLinkFromAnchor}
                  rel="noopener noreferrer"
                  className="ms-1 whitespace-nowrap underline hover:text-foreground"
                >
                  {t(
                    'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                    'Release notes'
                  )}
                </a>
              )}
            </>
          )}
          {stagedQuitVersion &&
            t(
              'updates.installOnQuit.summary',
              'Orca couldn’t restart automatically. Quit Orca when you’re ready to install the update.'
            )}
          {updateStatus.state === 'error' &&
            !stagedQuitVersion &&
            (updateStatus.installBlock
              ? getUpdateInstallBlockGuidance(updateStatus.installBlock, t).explainer
              : updateStatus.recovery?.kind === 'linux-package-install'
                ? updaterMessageText(updateStatus)
                : updateVersionRef.current
                  ? t(
                      'auto.components.settings.GeneralUpdateSettingsSection.b9ad70c30d',
                      'Update error. {{value0}}',
                      { value0: updaterMessageText(updateStatus) }
                    )
                  : t(
                      'auto.components.settings.GeneralUpdateSettingsSection.bd79d412f0',
                      'Update check failed. {{value0}}',
                      { value0: updaterMessageText(updateStatus) }
                    ))}
        </p>
      </SearchableSetting>
      {isWebClientLocation() ? null : <AutomaticUpdatesSetting />}
      <UpdateDelaySetting />
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
      {children}
    </SettingsGroup>
  )
}
