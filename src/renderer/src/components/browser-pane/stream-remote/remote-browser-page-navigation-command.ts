import type { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import type {
  BrowserBackResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserTabInfo
} from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import { deferBrowserPageNavigation } from '../navigate/browser-page-deferred-navigation'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'

type RemoteBrowserNavigationCommandOptions = Pick<
  Parameters<typeof useRemoteBrowserPageNavigation>[0],
  | 'browserTab'
  | 'stagedPage'
  | 'lifecycle'
  | 'runtimeWorktree'
  | 'runtimeTarget'
  | 'createRemoteOperationToken'
  | 'isCurrentRemoteOperationToken'
  | 'closeMissingRemotePage'
  | 'onUpdatePageState'
  | 'setPaneNotice'
  | 'setPaneBusy'
> & {
  navigationSequence: { current: number }
  applyRemoteTabInfo: (tab: BrowserTabInfo) => void
  applyRemoteTabMetadata: (tab: Pick<BrowserTabInfo, 'url' | 'title'>) => void
}

export async function runRemoteBrowserNavigationCommand(
  {
    browserTab,
    stagedPage,
    lifecycle,
    runtimeWorktree,
    runtimeTarget,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    closeMissingRemotePage,
    onUpdatePageState,
    setPaneNotice,
    setPaneBusy,
    navigationSequence,
    applyRemoteTabInfo,
    applyRemoteTabMetadata
  }: RemoteBrowserNavigationCommandOptions,
  method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
  url?: string
): Promise<void> {
  const target = runtimeTarget()
  if (!target) {
    return
  }
  if (stagedPage) {
    // No staged host page exists yet: park goto until adoption; history/reload cannot replay against an uncreated page.
    if (method === 'browser.goto' && url) {
      deferBrowserPageNavigation(browserTab.id, url)
      onUpdatePageState(browserTab.id, { loading: true, loadError: null })
    }
    return
  }
  const operationToken = createRemoteOperationToken()
  if (!operationToken) {
    return
  }
  const sequence = ++navigationSequence.current
  lifecycle.session.invalidateTabInfoReads()
  let pageId: string | null = null
  const ownsAction = (): boolean =>
    sequence === navigationSequence.current &&
    isCurrentRemoteOperationToken({ ...operationToken, remotePageId: pageId })
  setPaneBusy(true)
  setPaneNotice(null)
  // A standing failure stays visible until the native outcome is observed.
  onUpdatePageState(browserTab.id, { loading: true })
  try {
    pageId = await lifecycle.session.resolveNavigationPage(operationToken)
    if (!pageId || !ownsAction()) {
      return
    }
    const pageToken = { ...operationToken, remotePageId: pageId }
    const params =
      method === 'browser.goto'
        ? { worktree: runtimeWorktree, page: pageId, url: url ?? 'about:blank' }
        : { worktree: runtimeWorktree, page: pageId }
    let commandError: unknown
    let result: BrowserGotoResult | BrowserBackResult | BrowserReloadResult | undefined
    try {
      result = await callRuntimeRpc<BrowserGotoResult | BrowserBackResult | BrowserReloadResult>(
        target,
        method,
        params,
        { timeoutMs: 30_000, suppressFeatureInteraction: true }
      )
    } catch (error) {
      if (isRemoteBrowserPageMissingError(error)) {
        throw error
      }
      commandError = error
    }
    if (!ownsAction()) {
      return
    }
    let tab: BrowserTabInfo | null
    try {
      tab = await lifecycle.session.fetchTabInfo(pageToken)
    } catch (error) {
      if (!ownsAction()) {
        return
      }
      if (isRemoteBrowserPageMissingError(error)) {
        throw error
      }
      if (result) {
        if (!result.url.startsWith('chrome-error:')) {
          applyRemoteTabMetadata(result)
        }
        return
      }
      throw commandError ?? error
    }
    if (!ownsAction() || !tab) {
      return
    }
    applyRemoteTabInfo(tab)
    if (commandError && !tab.loadError) {
      throw commandError
    }
  } catch (error) {
    if (!ownsAction()) {
      return
    }
    if (isRemoteBrowserPageMissingError(error)) {
      closeMissingRemotePage(pageId)
      return
    }
    const message = error instanceof Error ? error.message : 'Remote browser command failed.'
    setPaneNotice({ kind: 'consequence', text: message })
    // Why: goto results carry no load error, but the rejection keeps Electron's "ERR_NAME (-code)" text.
    const netError = /\b(ERR_[A-Z_]+) \((-\d+)\)/.exec(message)
    onUpdatePageState(browserTab.id, {
      loading: false,
      // Why: validatedUrl is persisted, so redact the Kagi session token like the main-process failure path does.
      loadError: {
        code: netError ? Number(netError[2]) : 0,
        description: netError ? netError[1] : message,
        validatedUrl: redactKagiSessionToken(url ?? browserTab.url)
      }
    })
  } finally {
    if (ownsAction()) {
      onUpdatePageState(browserTab.id, { loading: false })
      setPaneBusy(false)
    }
  }
}
