import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { BrowserFavicon } from '@/components/browser-favicon'
import { useLocalhostLabelRouteForPort } from '@/lib/workspace-port-localhost-label-selector'
import { addressForPort } from '@/lib/workspace-port-urls'
import {
  openWorkspacePortInBrowser,
  resolveWorkspacePortBrowserUrl
} from '@/lib/workspace-port-actions'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { BrowserNewTabRow } from './browser-new-tab-row'
import type { BrowserNewTabServer } from './use-browser-new-tab-servers'

export function BrowserNewTabServerRow({
  server,
  runtimeTarget,
  openInPlace,
  showOwner = false,
  onOpenUrl
}: {
  server: BrowserNewTabServer
  runtimeTarget: RuntimeClientTarget
  /** False when this tab's page runs on another machine than the port, which only a new tab on the port's host can reach. */
  openInPlace: boolean
  /** Names the worktree the server belongs to, for servers of other workspaces. */
  showOwner?: boolean
  onOpenUrl: (url: string) => void
}): React.JSX.Element {
  const { port, title, faviconDataUrl } = server
  const localhostLabelRoute = useLocalhostLabelRouteForPort(port)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const address = addressForPort(port)
  const context = showOwner && port.kind === 'workspace' ? port.owner.displayName : port.processName

  const open = async (): Promise<void> => {
    if (openInPlace) {
      onOpenUrl(await resolveWorkspacePortBrowserUrl({ port, runtimeTarget, localhostLabelRoute }))
      return
    }
    const result = await openWorkspacePortInBrowser({
      port,
      runtimeTarget,
      createBrowserTab,
      setRemoteBrowserPageHandle,
      localhostLabelRoute
    })
    if (!result.ok) {
      toast.error(
        translate('browser.newTab.openServerFailed', 'Couldn’t open {{address}}', { address }),
        { description: result.reason }
      )
    }
  }

  return (
    <BrowserNewTabRow
      icon={
        <BrowserFavicon
          faviconUrl={faviconDataUrl}
          className="size-4"
          fallbackClassName="text-muted-foreground"
        />
      }
      title={title ?? port.processName ?? address}
      detail={
        <>
          <span className="font-mono">{address}</span>
          {context ? ` · ${context}` : null}
        </>
      }
      onOpen={() => void open()}
    />
  )
}
