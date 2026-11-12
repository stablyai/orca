import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import {
  mediaPlaybackPositionCache,
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
    const restorePosition = (): void => {
      const saved = playbackCacheKey ? mediaPlaybackPositionCache.get(playbackCacheKey) : undefined
      if (saved !== undefined && Number.isFinite(media.duration)) {
        media.currentTime = Math.min(saved, media.duration)
      }
    }
    media.addEventListener('loadedmetadata', restorePosition, { once: true })
    // Strict Mode replays cleanup while retaining the DOM element.
    media.src = src
    return () => {
      media.removeEventListener('loadedmetadata', restorePosition)
      // Unloaded metadata leaves currentTime at zero, which must not replace saved progress.
      if (playbackCacheKey && Number.isFinite(media.duration)) {
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
