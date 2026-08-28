import { X } from 'lucide-react'
import type { ChangelogData } from '../../../../../shared/update-status-types'
import { Button } from '../../ui/button'
import { translate } from '@/i18n/i18n'

function isAnimatedGif(url: string | undefined): boolean {
  return typeof url === 'string' && url.toLowerCase().endsWith('.gif')
}

export function UpdateAvailableRichContent({
  release,
  releasesBehind,
  prefersReducedMotion,
  mediaFailed,
  mediaLoaded,
  onMediaError,
  onMediaLoad,
  onUpdate,
  onClose
}: {
  release: NonNullable<ChangelogData['release']>
  releasesBehind: number | null
  prefersReducedMotion: boolean
  mediaFailed: boolean
  mediaLoaded: boolean
  onMediaError: () => void
  onMediaLoad: () => void
  onUpdate: () => void
  onClose: () => void
}): React.JSX.Element {
  const showMedia =
    release.mediaUrl && !mediaFailed && !(prefersReducedMotion && isAnimatedGif(release.mediaUrl))
  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('auto.components.UpdateCard.f58b5c57a6', 'New:')} {release.title}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.318d3b4bc7', 'Dismiss update')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      {showMedia && (
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
        {release.description}
        {releasesBehind !== null && releasesBehind > 1 && (
          <>
            {' '}
            <button
              type="button"
              className="text-xs text-muted-foreground/70 underline hover:text-foreground inline"
              onClick={() => void window.api.shell.openUrl(release.releaseNotesUrl)}
            >
              +{releasesBehind - 1}{' '}
              {translate('auto.components.UpdateCard.ccd8b0a793', 'more since your last update')}
            </button>
          </>
        )}
      </p>
      <button
        type="button"
        className="text-xs text-muted-foreground underline hover:text-foreground self-start"
        onClick={() => void window.api.shell.openUrl(release.releaseNotesUrl)}
      >
        {translate('auto.components.UpdateCard.aad383aecc', 'Read the full release notes')}
      </button>
      <Button variant="default" size="sm" onClick={onUpdate} className="w-full cursor-pointer">
        {translate('auto.components.UpdateCard.ec8fe71cfc', 'Update')}
      </Button>
    </div>
  )
}

export function UpdateAvailableSimpleContent({
  version,
  releaseUrl,
  onUpdate,
  onClose
}: {
  version: string
  releaseUrl?: string
  onUpdate: () => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2.5 p-3.5">
      <div className="flex items-start justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {translate('auto.components.UpdateCard.9abc59f814', 'Update Available')}
        </h3>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 min-w-[44px] min-h-[44px] -m-2"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.318d3b4bc7', 'Dismiss update')}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        {translate('auto.components.UpdateCard.05ad78a6d1', 'Orca v{{value0}} is ready.', {
          value0: version
        })}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {translate('auto.components.UpdateCard.fdd4a364fa', "Sessions won't be interrupted.")}
      </p>
      {releaseUrl && (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground self-start"
          onClick={() => void window.api.shell.openUrl(releaseUrl)}
        >
          {translate('auto.components.UpdateCard.44324ef542', 'Release notes')}
        </button>
      )}
      <Button
        variant="default"
        size="sm"
        onClick={onUpdate}
        className="mt-0.5 w-full cursor-pointer"
      >
        {translate('auto.components.UpdateCard.ec8fe71cfc', 'Update')}
      </Button>
    </div>
  )
}
