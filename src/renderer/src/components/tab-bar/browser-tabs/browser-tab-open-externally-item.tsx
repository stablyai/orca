import { ExternalLink } from 'lucide-react'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { getBrowserPageRuntimeEnvironmentId } from '../../../../../shared/browser/browser-page-runtime-owner'
import { getBrowserPagesForWorkspace } from '../../browser-pane/assemble-chrome/browser-pane-page-selection'
import { getLiveBrowserUrl } from '../../browser-pane/describe-page/live-browser-url-registry'
import {
  getOpenableExternalUrl,
  getRemoteRoutedOpenableExternalUrl,
  getSshRoutedOpenableExternalUrl
} from '../../browser-pane/describe-page/browser-page-url-display'
import {
  useSshRoutedPagePortForwards,
  useSshWorkspaceBrowsesThroughHost
} from '../../browser-pane/assemble-chrome/profile-routing/use-ssh-workspace-browser-route'

/** Mounted only while the tab menu is open; opens what the page's own menus open for its network. */
export function BrowserTabOpenExternallyItem({
  tab,
  onOpen
}: {
  tab: BrowserWorkspace
  onOpen: (url: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  // A server-hosted page browses through that server, whose loopback this desktop cannot reach.
  const serverHosted = useAppStore((s) => {
    const pages = getBrowserPagesForWorkspace(s.browserPagesByWorkspace, tab.id)
    const page = pages.find((candidate) => candidate.id === tab.activePageId) ?? pages[0]
    return Boolean(
      page &&
      getBrowserPageRuntimeEnvironmentId(
        page,
        runtimeEnvironmentIdOrLocalUnlessTwin(s, tab.worktreeId)
      )
    )
  })
  const sshRouted = useSshWorkspaceBrowsesThroughHost(tab.worktreeId) && !serverHosted
  const sshPortForwards = useSshRoutedPagePortForwards(tab.worktreeId, sshRouted)
  const liveUrl = getLiveBrowserUrl(tab.id) ?? tab.url
  const externalUrl = serverHosted
    ? getRemoteRoutedOpenableExternalUrl(liveUrl)
    : sshRouted
      ? getSshRoutedOpenableExternalUrl(liveUrl, sshPortForwards)
      : getOpenableExternalUrl(liveUrl)
  return (
    <ContextMenuItem onSelect={() => externalUrl && onOpen(externalUrl)} disabled={!externalUrl}>
      <ExternalLink className="size-3.5" />
      {t('auto.components.tab.bar.BrowserTab.6e0bc8f3a8', 'Open In Browser')}
    </ContextMenuItem>
  )
}
