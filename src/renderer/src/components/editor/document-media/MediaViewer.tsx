import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  mediaPlaybackStateCache,
  mediaVolumePreference,
  setWithLRU
} from '@/components/editor/model-lifetime/retention/editor-view-state-cache'

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
  const t = useTranslate()
  const mediaRef = useRef<HTMLMediaElement>(null)
  const [failed, setFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    const media = mediaRef.current
    if (!media) {
      return
    }
    let lastSyncedVolume = { ...mediaVolumePreference }
    media.volume = lastSyncedVolume.volume
    media.muted = lastSyncedVolume.muted
    const saveVolume = (): void => {
      lastSyncedVolume = { volume: media.volume, muted: media.muted }
      Object.assign(mediaVolumePreference, lastSyncedVolume)
    }
    // Loading a source resets playbackRate to defaultPlaybackRate, so speed is restored with position.
    const restorePlayback = (): void => {
      const saved = playbackCacheKey ? mediaPlaybackStateCache.get(playbackCacheKey) : undefined
      if (!saved) {
        return
      }
      media.playbackRate = saved.playbackRate
      // Unfinalized recordings such as screen-captured WebM report Infinity and cannot seek reliably.
      if (Number.isFinite(media.duration)) {
        media.currentTime = Math.min(saved.currentTime, media.duration)
      }
    }
    media.addEventListener('volumechange', saveVolume)
    media.addEventListener('loadedmetadata', restorePlayback, { once: true })
    // Strict Mode replays cleanup while retaining the DOM element.
    media.src = src
    return () => {
      media.removeEventListener('volumechange', saveVolume)
      media.removeEventListener('loadedmetadata', restorePlayback)
      // volumechange is queued, so a change made right before leaving may not have fired yet.
      if (media.volume !== lastSyncedVolume.volume || media.muted !== lastSyncedVolume.muted) {
        saveVolume()
      }
      // NaN duration means metadata never loaded, so currentTime and playbackRate are still defaults.
      if (playbackCacheKey && !Number.isNaN(media.duration)) {
        setWithLRU(mediaPlaybackStateCache, playbackCacheKey, {
          currentTime: media.ended ? 0 : media.currentTime,
          playbackRate: media.playbackRate
        })
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
            {t(
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
              {t('mediaPreview.openFailed', 'Could not open this file in the default app.')}
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
            {t('mediaPreview.openDefault', 'Open in Default App')}
          </Button>
        </div>
      )}
    </div>
  )
}
