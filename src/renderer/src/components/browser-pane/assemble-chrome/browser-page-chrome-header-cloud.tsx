import type React from 'react'
import { CloudDesktopTabSurface } from '../../cloud-remote-desktop/CloudDesktopTabSurface'
import { isCloudRemoteDesktopTabUrl } from '../../../../../shared/hosted-sandbox/cloud-remote-desktop'
import { BrowserPageChromeHeader } from './browser-page-chrome-header'

/**
 * The page chrome, or for an Orca Cloud remote desktop tab (which has no address bar) its own
 * toolbar and a cover over the page while it can't show.
 */
export function BrowserPageChromeHeaderOrCloudDesktop({
  viewportContainer,
  ...props
}: React.ComponentProps<typeof BrowserPageChromeHeader> & {
  viewportContainer: HTMLElement | null
}): React.JSX.Element {
  if (!isCloudRemoteDesktopTabUrl(props.browserTab.url)) {
    return <BrowserPageChromeHeader {...props} />
  }
  return (
    <CloudDesktopTabSurface
      chromeHeaderRef={props.chromeHeaderRef}
      worktreeId={props.worktreeId}
      browserPageId={props.browserTab.id}
      url={props.browserTab.url}
      reload={() => props.reload.reloadWebviewOrRecoverGuest(false)}
      navigate={props.nav.navigateToUrl}
      viewportContainer={viewportContainer}
    />
  )
}
