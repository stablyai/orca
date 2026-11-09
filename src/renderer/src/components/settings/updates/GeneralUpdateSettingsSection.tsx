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
import { updaterMessageText } from '@/lib/updater-message-copy'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import { UpdateDelaySetting } from './UpdateDelaySetting'
import { formatUpdateDelayDate } from './update-delay-copy'
import { useNow } from '@/hooks/use-now'
import { isDelayedUpdatePending } from '../../../../../shared/update-delay'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import { openAppHttpLinkFromAnchor } from '@/lib/browser/navigation/app-http-link-open'

export function GeneralUpdateSettingsSection(): React.JSX.Element {
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
    // quitAndInstall schedules quitting and resolves early; only broken IPC can reject here.
    void window.api.updater.quitAndInstall().catch(console.error)
  }

  return (
    <SettingsGroup
      key="updates"
      title={t('auto.components.settings.GeneralUpdateSettingsSection.f2b1ccc12a', 'Updates')}
      onHeaderClick={(event) => {
        if (event.altKey) {
          setChannelSwitcherRevealed((revealed) => !revealed)
        }
      }}
      description={t(
        'auto.components.settings.GeneralUpdateSettingsSection.d91ebfb87e',
        'Current version: {{value0}}',
        { value0: appVersion ?? '...' }
      )}
    >
      <SearchableSetting
        title={t(
          'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
          'Check for Updates'
        )}
        description={t(
          'auto.components.settings.GeneralUpdateSettingsSection.ceb579abaf',
          'Check for app updates and install a newer Orca version.'
        )}
        keywords={['update', 'version', 'release notes', 'download']}
        className="space-y-3 py-3"
      >
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            // Modifier clicks are one-off update actions, not saved toggles.
            onClick={(event) => window.api.updater.check(getUpdateCheckClickOptions(event))}
            title={updateCheckHint}
            disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
            className="gap-2"
          >
            {updateStatus.state === 'checking' ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t(
              'auto.components.settings.GeneralUpdateSettingsSection.e1a647adc5',
              'Check for Updates'
            )}
          </Button>

          {updateStatus.state === 'available' && !updateStatus.externallyManaged ? (
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
                'auto.components.settings.GeneralUpdateSettingsSection.42717918f4',
                'Download Update ('
              )}
              {updateStatus.version})
            </Button>
          ) : updateStatus.state === 'error' &&
            updateStatus.retryAction === 'install' &&
            updateStatus.retryable !== false ? (
            <Button variant="default" size="sm" onClick={handleRestartToUpdate} className="gap-2">
              <RefreshCw className="size-3.5" />
              {t('auto.components.UpdateCard.2c2d3e03ca', 'Try Again')}
            </Button>
          ) : updateStatus.state === 'downloaded' ? (
            <Button
              variant="default"
              size="sm"
              onClick={handleRestartToUpdate}
              disabled={updateStatus.installing}
              className="gap-2"
            >
              <Download className="size-3.5" />
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.f44299636f',
                'Restart to Update ('
              )}
              {updateStatus.version})
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
              {t('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
              {updateStatus.version}{' '}
              {updateStatus.externallyManaged
                ? t(
                    'auto.components.settings.GeneralUpdateSettingsSection.e3b9d21c07',
                    'is available. Update Orca through your system package manager — Orca cannot install this release itself.'
                  )
                : t(
                    'auto.components.settings.GeneralUpdateSettingsSection.8311da27ba',
                    'is available. Click "Download Update" to download it.'
                  )}{' '}
              {updateStatus.source !== 'local' && (
                <a
                  href={
                    updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)
                  }
                  target="_blank"
                  onClick={openAppHttpLinkFromAnchor}
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
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
              'auto.components.settings.GeneralUpdateSettingsSection.2a48034c4c',
              'Downloading v{{value0}}... {{value1}}%',
              { value0: updateStatus.version, value1: updateStatus.percent }
            )}
          {updateStatus.state === 'downloaded' && (
            <>
              {t('auto.components.settings.GeneralUpdateSettingsSection.a6b37929dc', 'Version')}{' '}
              {updateStatus.version}{' '}
              {t(
                'auto.components.settings.GeneralUpdateSettingsSection.d89806cc89',
                'is ready to install.'
              )}{' '}
              {updateStatus.source !== 'local' && (
                <a
                  href={
                    updateStatus.releaseUrl ?? getReleaseNotesUrlForVersion(updateStatus.version)
                  }
                  target="_blank"
                  onClick={openAppHttpLinkFromAnchor}
                  rel="noopener noreferrer"
                  className="underline hover:text-foreground"
                >
                  {t(
                    'auto.components.settings.GeneralUpdateSettingsSection.8a52ca1d02',
                    'Release notes'
                  )}
                </a>
              )}
            </>
          )}
          {updateStatus.state === 'error' &&
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
      <UpdateDelaySetting />
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
    </SettingsGroup>
  )
}
