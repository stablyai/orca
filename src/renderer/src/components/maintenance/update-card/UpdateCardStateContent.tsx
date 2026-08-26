import type {
  ChangelogData,
  LinuxPackageInstallRecovery,
  UpdateStatus
} from '../../../../../shared/update-status-types'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import { UpdateErrorCardContent, type UpdateErrorCardModel } from '../../UpdateErrorCardContent'
import { LinuxPackageInstallRecoveryCard } from '../../LinuxPackageInstallRecoveryCard'
import { translate } from '@/i18n/i18n'
import { UpdateCheckFeedback } from './UpdateCheckFeedback'
import {
  UpdateAvailableRichContent,
  UpdateAvailableSimpleContent
} from './UpdateAvailableCardContent'
import { UpdateDownloadingContent, UpdateReadyToInstallContent } from './UpdateDownloadCardContent'

export function UpdateCardStateContent({
  status,
  changelog,
  errorCard,
  linuxPackageRecovery,
  isLocalBuild,
  cachedVersion,
  hasStartedDownload,
  prefersReducedMotion,
  mediaFailed,
  mediaLoaded,
  onMediaError,
  onMediaLoad,
  onUpdate,
  onInstallRetry,
  onDismiss,
  onCollapse
}: {
  status: UpdateStatus
  changelog: ChangelogData | null
  errorCard: UpdateErrorCardModel | null
  linuxPackageRecovery: {
    recovery: LinuxPackageInstallRecovery
    diagnostic: string
  } | null
  isLocalBuild: boolean
  cachedVersion: string | null
  hasStartedDownload: boolean
  prefersReducedMotion: boolean
  mediaFailed: boolean
  mediaLoaded: boolean
  onMediaError: () => void
  onMediaLoad: () => void
  onUpdate: () => void
  onInstallRetry: () => void
  onDismiss: () => void
  onCollapse: () => void
}): React.JSX.Element | null {
  if (status.state === 'checking') {
    return (
      <UpdateCheckFeedback
        icon="spinner"
        text={translate('auto.components.UpdateCard.ba5ffc949c', 'Checking for updates...')}
      />
    )
  }
  if (status.state === 'not-available') {
    return (
      <UpdateCheckFeedback
        icon="check"
        text={translate('auto.components.UpdateCard.ea2a41adbe', "You're on the latest version.")}
      />
    )
  }
  if (linuxPackageRecovery) {
    return (
      <LinuxPackageInstallRecoveryCard
        recovery={linuxPackageRecovery.recovery}
        diagnostic={linuxPackageRecovery.diagnostic}
        releaseUrl={isLocalBuild ? undefined : getReleaseNotesUrlForVersion(cachedVersion)}
        onClose={onCollapse}
      />
    )
  }
  if (errorCard) {
    return <UpdateErrorCardContent {...errorCard} onClose={onCollapse} />
  }
  if (status.state === 'downloaded') {
    return hasStartedDownload ? (
      <div className="p-4">
        <p className="text-sm">
          {translate('auto.components.UpdateCard.09a55c39b5', 'Installing...')}
        </p>
      </div>
    ) : (
      <UpdateReadyToInstallContent
        version={status.version}
        onRestart={onInstallRetry}
        onClose={onCollapse}
      />
    )
  }
  if (status.state === 'downloading') {
    return (
      <UpdateDownloadingContent
        version={status.version}
        percent={status.percent}
        changelog={changelog}
        prefersReducedMotion={prefersReducedMotion}
        mediaFailed={mediaFailed}
        mediaLoaded={mediaLoaded}
        onMediaError={onMediaError}
        onMediaLoad={onMediaLoad}
        onCollapse={onCollapse}
        showReleaseNotes={!isLocalBuild}
      />
    )
  }
  if (status.state !== 'available') {
    return null
  }
  const releaseUrl = isLocalBuild
    ? undefined
    : (status.releaseUrl ?? getReleaseNotesUrlForVersion(status.version))
  return changelog?.release ? (
    <UpdateAvailableRichContent
      release={changelog.release}
      releasesBehind={changelog.releasesBehind}
      prefersReducedMotion={prefersReducedMotion}
      mediaFailed={mediaFailed}
      mediaLoaded={mediaLoaded}
      onMediaError={onMediaError}
      onMediaLoad={onMediaLoad}
      onUpdate={onUpdate}
      onClose={onDismiss}
    />
  ) : (
    <UpdateAvailableSimpleContent
      version={status.version}
      releaseUrl={releaseUrl}
      onUpdate={onUpdate}
      onClose={onDismiss}
    />
  )
}
