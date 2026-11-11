import type React from 'react'
import type { RefObject } from 'react'
import { createPortal } from 'react-dom'
import { useCloudDesktopConnection } from '@/lib/cloud-remote-desktop/use-cloud-desktop-connection'
import { CloudDesktopTabCover, CloudDesktopTabToolbar } from './CloudDesktopTabChrome'

/** A remote desktop tab's chrome: a toolbar in place of the address bar, and a cover over the page. */
export function CloudDesktopTabSurface({
  chromeHeaderRef,
  worktreeId,
  browserPageId,
  url,
  reload,
  navigate,
  viewportContainer
}: {
  chromeHeaderRef: RefObject<HTMLDivElement | null>
  worktreeId: string
  browserPageId: string
  url: string
  reload: () => void
  navigate: (url: string) => void
  viewportContainer: HTMLElement | null
}): React.JSX.Element {
  const { phase, reconnect } = useCloudDesktopConnection({
    enabled: true,
    worktreeId,
    browserPageId,
    url,
    reload,
    navigate
  })
  return (
    <>
      <CloudDesktopTabToolbar
        chromeHeaderRef={chromeHeaderRef}
        phase={phase}
        onReconnect={reconnect}
      />
      {viewportContainer
        ? createPortal(
            <CloudDesktopTabCover worktreeId={worktreeId} phase={phase} onReconnect={reconnect} />,
            viewportContainer
          )
        : null}
    </>
  )
}
