import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useEffect, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'

export default function MediaViewer({
  src,
  mimeType,
  filePath,
  canOpenLocally
}: {
  src: string
  mimeType: string
  filePath: string
  canOpenLocally: boolean
}): React.JSX.Element {
  const mediaRef = useRef<HTMLMediaElement>(null)
  const [failed, setFailed] = useState(false)
  const [openFailed, setOpenFailed] = useState(false)
  useEffect(() => {
    const media = mediaRef.current
    // Strict Mode replays cleanup while retaining the DOM element.
    if (media) {
      media.src = src
    }
    return () => {
      if (!media) {
        return
      }
      media.pause()
      media.removeAttribute('src')
      media.load()
    }
  }, [src])

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
