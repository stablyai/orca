import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '../../../store/index'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { useTranslate } from '@/i18n/use-translate'
import { GeneralRemoteServerUpdates } from './GeneralRemoteServerUpdates'
import { ReleaseChannelSection } from './ReleaseChannelSection'
import { UpdateDelaySetting } from './UpdateDelaySetting'
import { AutomaticUpdatesSetting } from './AutomaticUpdatesSetting'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { useNow } from '@/lib/window-activity/use-now'
import { getOrcaCloudTeamCapabilities } from '../../../../../shared/orca-profiles/orca-cloud-team-policy'
import { getBuiltInAppIconUrl } from '../appearance/app-icon-urls'
import { UpdateStatusRow } from './UpdateStatusRow'
import { getUpdateStatusRowModel } from './update-status-row-model'

export function GeneralUpdateSettingsSection({
  headerAction
}: { headerAction?: React.ReactNode } = {}): React.JSX.Element {
  const t = useTranslate()
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
  const installTarget = useAppStore((s) => s.retainedUpdateTarget)
  const appIcon = useAppStore((s) => s.settings?.appIcon)
  const teamDelayDays = useAppStore(
    (s) => getOrcaCloudTeamCapabilities(s.orcaProfileAuthStatus)?.teamPolicy?.updateDelayDays
  )
  const [failedRestartTarget, setFailedRestartTarget] = useState<typeof installTarget>(null)
  const showManualRestart =
    updateStatus.installOnQuit === true &&
    (updateStatus.state === 'error' ||
      (updateStatus.state === 'downloaded' &&
        !updateStatus.installing &&
        installTarget !== null &&
        failedRestartTarget === installTarget))
  const now = useNow(
    60_000,
    updateStatus.state === 'not-available' && Boolean(updateStatus.delayedUpdate)
  )
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
      setFailedRestartTarget(installTarget)
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

  const handleDownload = (): void => {
    void window.api.updater.download().catch((error) => {
      toast.error(
        t(
          'auto.components.settings.GeneralUpdateSettingsSection.02dc082e70',
          'Could not start the update download.'
        ),
        { description: String((error as Error)?.message ?? error) }
      )
    })
  }

  const model = getUpdateStatusRowModel(updateStatus, {
    showManualRestart,
    retainedVersion: updateVersionRef.current,
    canSkipDelay: teamDelayDays === undefined,
    now
  })

  return (
    <SettingsGroup
      key="updates"
      title={t('settings.general.about.title', 'About')}
      action={
        // The header sits 4px in; this lines a ghost action's text up with the rows' 20px right edge.
        headerAction ? <div className="pe-2">{headerAction}</div> : undefined
      }
      onHeaderClick={(event) => {
        // Only the title reveals channels; an Option-click on the header's Star must stay a star.
        const onAction = event.target instanceof Element && event.target.closest('button')
        if (event.altKey && !onAction) {
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
      >
        <UpdateStatusRow
          model={model}
          status={updateStatus}
          appVersion={appVersion}
          iconUrl={getBuiltInAppIconUrl(appIcon)}
          onDownload={handleDownload}
          onRestart={handleRestartToUpdate}
        />
      </SearchableSetting>
      {isWebClientLocation() ? null : <AutomaticUpdatesSetting />}
      <UpdateDelaySetting />
      {channelSwitcherRevealed ? <ReleaseChannelSection /> : null}
      <GeneralRemoteServerUpdates />
    </SettingsGroup>
  )
}
