import { Globe } from 'lucide-react'
import { useMemo } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useBrowserAutomationPageIds } from '@/lib/browser-automation-activity'
import { activateBrowserPagePaletteResult } from '@/lib/browser-page-palette-activation'
import { openRoutedHttpLink } from '@/lib/http-link-destinations'
import {
  nativeChatBrowserExternalUrl,
  nativeChatBrowserSourceOwner,
  selectNativeChatBrowserNotices,
  createNativeChatBrowserNoticeSelector,
  type NativeChatBrowserNoticeTarget
} from './native-chat-browser-notice'

export function NativeChatBrowserNotice({ tabId }: { tabId: string }): React.JSX.Element {
  const observedPageIds = useBrowserAutomationPageIds()
  const selectTargets = useMemo(
    () => createNativeChatBrowserNoticeSelector(tabId, observedPageIds),
    [tabId, observedPageIds]
  )
  const targets = useAppStore(selectTargets)
  return (
    <div aria-live="polite" className="shrink-0">
      {targets.length > 0 ? (
        <ul className="scrollbar-sleek mx-auto max-h-32 w-full max-w-(--chat-content-max-width) overflow-y-auto px-3 pt-2 sm:px-4">
          {targets.map((target) => (
            <BrowserNoticeRow key={target.page.id} target={target} tabId={tabId} />
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function BrowserNoticeRow({
  target,
  tabId
}: {
  target: NativeChatBrowserNoticeTarget
  tabId: string
}): React.JSX.Element | null {
  const { page } = target
  const pageId = page.id
  const externalUrl = nativeChatBrowserExternalUrl(page, target.executionHostId)
  const currentTarget = () =>
    selectNativeChatBrowserNotices(useAppStore.getState(), tabId, [pageId])[0]
  const showBrowser = () => {
    const current = currentTarget()
    const result =
      current &&
      activateBrowserPagePaletteResult({
        pageId,
        workspaceId: current.page.workspaceId,
        worktreeId: current.page.worktreeId,
        executionHostId: current.executionHostId
      })
    if (!result || result.status === 'failed') {
      toast.error(translate('browser.notice.unavailable', 'This browser is no longer available.'))
    }
  }
  const openInDefaultBrowser = () => {
    const current = currentTarget()
    const url = current && nativeChatBrowserExternalUrl(current.page, current.executionHostId)
    if (!current || !url) {
      return
    }
    openRoutedHttpLink(url, {
      worktreeId: current.page.worktreeId,
      sourceOwner: nativeChatBrowserSourceOwner(current.executionHostId),
      forceDestination: 'system'
    })
  }
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1 text-xs text-chat-foreground-faint">
      <Globe aria-hidden className="size-3.5 shrink-0" />
      <span>{translate('browser.notice.opened', 'A browser was opened in this workspace.')}</span>
      <Button type="button" variant="link" size="xs" onClick={showBrowser}>
        {translate('browser.notice.show', 'Show in Orca')}
      </Button>
      <span className="min-w-0 flex-1 truncate">{page.title}</span>
      {externalUrl ? (
        <Button type="button" variant="ghost" size="xs" onClick={openInDefaultBrowser}>
          {translate('browser.notice.openDefault', 'Open site in default browser')}
        </Button>
      ) : null}
    </li>
  )
}
