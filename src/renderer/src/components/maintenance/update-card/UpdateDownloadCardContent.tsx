import type { ChangelogData } from '../../../../../shared/updater/update-status-types'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/updater/release-channel'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
import { ProgressCardHeader } from '../progress-card/ProgressCard'
import { useTranslate } from '@/i18n/use-translate'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

function isAnimatedGif(url: string | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().endsWith('.gif')
}

export function UpdateDownloadingContent({
  version,
  percent,
  changelog,
  prefersReducedMotion,
  mediaFailed,
  mediaLoaded,
  onMediaError,
  onMediaLoad,
  onCollapse,
  showReleaseNotes
}: {
  version: string
  percent: number
  changelog: ChangelogData | null
  prefersReducedMotion: boolean
  mediaFailed: boolean
  mediaLoaded: boolean
  onMediaError: () => void
  onMediaLoad: () => void
  onCollapse: () => void
  showReleaseNotes: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const release = changelog?.release
  const showMedia =
    release?.mediaUrl && !mediaFailed && !(prefersReducedMotion && isAnimatedGif(release.mediaUrl))
  return (
    <div className="flex flex-col gap-3 p-4">
      <ProgressCardHeader
        title={
          release
            ? `${t('auto.components.UpdateCard.f58b5c57a6', 'New:')} ${release.title}`
            : t('auto.components.UpdateCard.558842597d', 'Downloading Update')
        }
        onMinimize={onCollapse}
      />
      {showMedia && release?.mediaUrl && (
        <div className="relative overflow-hidden rounded-md">
          {!mediaLoaded && (
            <div
              className="w-full bg-muted/50 animate-pulse rounded-md"
              style={{ aspectRatio: '16/9' }}
            />
          )}
          <img
            src={release.mediaUrl}
            alt=""
            className={`w-full rounded-md ${mediaLoaded ? '' : 'absolute inset-0'}`}
            style={!mediaLoaded ? { visibility: 'hidden' } : undefined}
            onError={onMediaError}
            onLoad={onMediaLoad}
          />
        </div>
      )}
      <p className="text-sm text-muted-foreground">
        {release
          ? release.description
          : t('auto.components.UpdateCard.93794ea932', 'Orca v{{value0}} is downloading.', {
              value0: version
            })}
      </p>
      {showReleaseNotes && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground self-start"
          onClick={(event) =>
            openAppHttpLink(
              release ? release.releaseNotesUrl : getReleaseNotesUrlForVersion(version),
              { event }
            )
          }
        >
          {release
            ? t('auto.components.UpdateCard.aad383aecc', 'Read the full release notes')
            : t('auto.components.UpdateCard.44324ef542', 'Release notes')}
        </button>
      )}
      <div className="flex flex-col gap-2 mt-1">
        <Progress value={percent} className="h-1.5" />
        <p className="text-xs text-muted-foreground">
          {t('auto.components.UpdateCard.downloadingPercent', 'Downloading... {{percent}}%', {
            percent
          })}
        </p>
      </div>
    </div>
  )
}

export function UpdateReadyToInstallContent({
  version,
  onRestart,
  onClose
}: {
  version: string
  onRestart: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-3 p-4">
      <ProgressCardHeader
        title={t('auto.components.UpdateCard.17412483da', 'Ready to Install')}
        onMinimize={onClose}
      />
      <p className="text-sm text-muted-foreground">
        {t(
          'auto.components.UpdateCard.6714206e5a',
          "Orca v{{value0}} is downloaded. Restart when you're ready.",
          { value0: version }
        )}
      </p>
      <Button variant="default" size="sm" onClick={onRestart} className="w-full">
        {t('auto.components.UpdateCard.68b235d264', 'Restart to Update')}
      </Button>
    </div>
  )
}
