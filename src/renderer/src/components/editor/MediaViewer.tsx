import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import {
  mediaPlaybackPositionCache,
  mediaPlaybackRateCache,
  mediaVolumePreference,
  setWithLRU
} from '@/lib/scroll-cache'

export default function MediaViewer({
  src,
  mimeType,
  filePath,
  canOpenLocally,
  playbackCacheKey = null
}: {
  src: string
  mimeType: string
  filePath: string
  canOpenLocally: boolean
  playbackCacheKey?: string | null
}): React.JSX.Element {
  const mediaRef = useRef<HTMLMediaElement>(null)
  const [failed, setFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    const media = mediaRef.current
    if (!media) {
      return
    }
    const restorePlayback = (): void => {
      const saved = playbackCacheKey ? mediaPlaybackPositionCache.get(playbackCacheKey) : undefined
      if (saved !== undefined && Number.isFinite(media.duration)) {
        media.currentTime = Math.min(saved, media.duration)
      }
      // Loading a source resets playbackRate, so the saved speed applies only once metadata exists.
      const savedRate = playbackCacheKey ? mediaPlaybackRateCache.get(playbackCacheKey) : undefined
      if (savedRate !== undefined) {
        media.playbackRate = savedRate
      }
    }
    let known = { ...mediaVolumePreference }
    const rememberVolume = (): void => {
      known = { volume: media.volume, muted: media.muted }
      Object.assign(mediaVolumePreference, known)
    }
    media.volume = known.volume
    media.muted = known.muted
    media.addEventListener('loadedmetadata', restorePlayback, { once: true })
    media.addEventListener('volumechange', rememberVolume)
    // Strict Mode replays cleanup while retaining the DOM element.
    media.src = src
    return () => {
      media.removeEventListener('loadedmetadata', restorePlayback)
      media.removeEventListener('volumechange', rememberVolume)
      // volumechange is queued, so a change made right before leaving may not have been saved yet.
      if (media.volume !== known.volume || media.muted !== known.muted) {
        rememberVolume()
      }
      // Unloaded metadata leaves currentTime and playbackRate reset, which must not replace saved values.
      if (playbackCacheKey && Number.isFinite(media.duration)) {
        setWithLRU(mediaPlaybackRateCache, playbackCacheKey, media.playbackRate)
        if (media.ended) {
          mediaPlaybackPositionCache.delete(playbackCacheKey)
        } else {
          setWithLRU(mediaPlaybackPositionCache, playbackCacheKey, media.currentTime)
        }
      }
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
  }, [src, playbackCacheKey])

  const playerProps = {
    ref: (element: HTMLMediaElement | null): void => {
      mediaRef.current = element
    },
    src,
    controls: true,
    preload: 'metadata',
    'aria-label': filePath.split(/[/\\]/).pop() || filePath,
    onError: (): void => setFailed(true)
  }
  return (
    <div className="flex h-full min-h-0 flex-col bg-background" data-orca-media-viewer>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        {failed ? (
          <p className="text-sm text-muted-foreground" role="alert">
            {translate(
              'mediaPreview.unavailable',
              'Unable to play this media file. The file may be unavailable or use an unsupported codec.'
            )}
          </p>
        ) : mimeType.startsWith('audio/') ? (
          <audio {...playerProps} className="w-full max-w-lg" />
        ) : (
          <video {...playerProps} className="max-h-full max-w-full" />
        )}
      </div>
      {canOpenLocally && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          {openFailed && (
            <p className="text-xs text-muted-foreground" role="alert">
              {translate('mediaPreview.openFailed', 'Could not open this file in the default app.')}
            </p>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                setOpenFailed(
                  !(await window.api.shell.openFilePath(filePath, LOCAL_EXECUTION_HOST_ID))
                )
              } catch {
                setOpenFailed(true)
              }
            }}
          >
            {translate('mediaPreview.openDefault', 'Open in Default App')}
          </Button>
        </div>
      )}
    </div>
  )
}
