import { Minus } from 'lucide-react'
import type { ChangelogData } from '../../../../../shared/update-status-types'
import { getReleaseNotesUrlForVersion } from '../../../../../shared/release-channel'
import { Button } from '../../ui/button'
import { Progress } from '../../ui/progress'
import { translate } from '@/i18n/i18n'

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
  const release = changelog?.release
  const showMedia =
    release?.mediaUrl && !mediaFailed && !(prefersReducedMotion && isAnimatedGif(release.mediaUrl))
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        {release ? (
          <h3 className="text-sm font-semibold">
            {translate('auto.components.UpdateCard.f58b5c57a6', 'New:')} {release.title}
          </h3>
        ) : (
          <h3 className="text-sm font-semibold">
            {translate('auto.components.UpdateCard.558842597d', 'Downloading Update')}
          </h3>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onCollapse}
          aria-label={translate('auto.components.UpdateCard.8acbdd3961', 'Minimize to status bar')}
        >
          <Minus className="size-3.5" />
        </Button>
      </div>
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
          : translate('auto.components.UpdateCard.93794ea932', 'Orca v{{value0}} is downloading.', {
              value0: version
            })}
      </p>
      {showReleaseNotes && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline hover:text-foreground self-start"
          onClick={() =>
            void window.api.shell.openUrl(
              release ? release.releaseNotesUrl : getReleaseNotesUrlForVersion(version)
            )
          }
        >
          {release
            ? translate('auto.components.UpdateCard.aad383aecc', 'Read the full release notes')
            : translate('auto.components.UpdateCard.44324ef542', 'Release notes')}
        </button>
      )}
      <div className="flex flex-col gap-2 mt-1">
        <Progress value={percent} className="h-1.5" />
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.UpdateCard.6e45bfa2e0', 'Downloading...')} {percent}%
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
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('auto.components.UpdateCard.17412483da', 'Ready to Install')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.8acbdd3961', 'Minimize to status bar')}
        >
          <Minus className="size-3.5" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.UpdateCard.6714206e5a',
          "Orca v{{value0}} is downloaded. Restart when you're ready.",
          { value0: version }
        )}
      </p>
      <Button variant="default" size="sm" onClick={onRestart} className="w-full">
        {translate('auto.components.UpdateCard.68b235d264', 'Restart to Update')}
      </Button>
    </div>
  )
}
