import { useCallback, useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { redactKagiSessionToken } from '../../../../../shared/browser-url'
import { normalizeBrowserHistoryUrl } from '../../../../../shared/workspace-session-browser-history'
import { resolveBrowserAddressBarSubmission } from '../navigate/browser-address-bar-navigation'
import { routeWorkspaceDocAddressSubmission } from '../navigate/workspace-doc-address-submission'
import { deferBrowserPageNavigation } from '../navigate/browser-page-deferred-navigation'
import { keybindingMatchesAction } from '../../../../../shared/keybindings'
import type {
  BrowserBackResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserTabInfo
} from '../../../../../shared/runtime-types'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import { getShortcutPlatform } from '@/hooks/useShortcutLabel'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { BrowserPageUrlSetter, BrowserTabPageState } from '../describe-page/browser-page-types'
import { getBrowserDisplayTitle, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageNavigation({
  browserTab,
  isActive,
  stagedPage,
  addressBarValue,
  setAddressBarValueFromPage,
  lifecycle,
  runtimeWorktree,
  runtimeTarget,
  createRemoteOperationToken,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  onSetUrl,
  onUpdatePageState,
  setPaneNotice,
  setPaneBusy
}: {
  browserTab: BrowserPageState
  isActive: boolean
  /** The host has not minted this page yet, so nothing here may be sent to the runtime. */
  stagedPage: boolean
  addressBarValue: string
  setAddressBarValueFromPage: (value: string) => void
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  onSetUrl: BrowserPageUrlSetter
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  setPaneBusy: (busy: boolean) => void
}): {
  applyRemoteTabInfo: (tab: Pick<BrowserTabInfo, 'url' | 'title'>) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  runRemoteNavigation: (
    method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
    url?: string
  ) => Promise<void>
  navigateToUrl: (url: string) => void
  submitAddressBar: () => void
} {
  const keybindings = useAppStore((state) => state.keybindings)
  const addBrowserHistoryEntry = useAppStore((state) => state.addBrowserHistoryEntry)
  const lastFiledHistoryRef = useRef<string | null>(null)

  const applyRemoteTabInfo = useCallback(
    (tab: Pick<BrowserTabInfo, 'url' | 'title'>): void => {
      const safeUrl = redactKagiSessionToken(tab.url || 'about:blank')
      const title = getBrowserDisplayTitle(tab.title, safeUrl)
      onSetUrl(browserTab.id, safeUrl)
      onUpdatePageState(browserTab.id, {
        title,
        loading: false,
        loadError: null
      })
      // Why: the address bar's suggestions read the client's shared URL history, so pages this
      // client drove on the runtime have to file their navigations there like a local guest does.
      // Only on a change, though: settled scrolls, clicks and keystrokes all re-read tab info,
      // and filing each one rewrites the store — re-rendering every address bar in the app.
      const filing = `${normalizeBrowserHistoryUrl(safeUrl)}\n${title}`
      if (filing !== lastFiledHistoryRef.current) {
        lastFiledHistoryRef.current = filing
        addBrowserHistoryEntry(safeUrl, title)
      }
      setAddressBarValueFromPage(toDisplayUrl(safeUrl))
    },
    [addBrowserHistoryEntry, browserTab.id, onSetUrl, onUpdatePageState, setAddressBarValueFromPage]
  )

  const scheduleRemoteTabInfoRefresh = useCallback(
    (token: RemoteBrowserOperationToken, delayMs = 250): void => {
      lifecycle.session.scheduleTabInfoRefresh(token, delayMs)
    },
    [lifecycle]
  )

  const runRemoteNavigation = useCallback(
    async (
      method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
      url?: string
    ) => {
      const target = runtimeTarget()
      if (!target) {
        return
      }
      if (stagedPage) {
        // Why: the runtime has no page under this id yet, so ensureRemotePage's browser.tabShow
        // answers browser_tab_not_found — which reads as "the page is gone" and closes the tab the
        // user is typing in. A goto is parked for whichever pane owns the page once it lands;
        // history and reload have nothing to replay against a page with no history yet.
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
      const pageId = await lifecycle.session.ensureRemotePage(operationToken)
      if (!pageId) {
        return
      }
      const pageToken = { ...operationToken, remotePageId: pageId }
      if (!isCurrentRemoteOperationToken(pageToken)) {
        return
      }
      setPaneBusy(true)
      setPaneNotice(null)
      onUpdatePageState(browserTab.id, { loading: true, loadError: null })
      try {
        const params =
          method === 'browser.goto'
            ? { worktree: runtimeWorktree, page: pageId, url: url ?? 'about:blank' }
            : { worktree: runtimeWorktree, page: pageId }
        const result = await callRuntimeRpc<
          BrowserGotoResult | BrowserBackResult | BrowserReloadResult
        >(target, method, params, { timeoutMs: 30_000, suppressFeatureInteraction: true })
        if (isCurrentRemoteOperationToken(pageToken)) {
          applyRemoteTabInfo(result)
        }
      } catch (error) {
        if (!isCurrentRemoteOperationToken(pageToken)) {
          return
        }
        if (isRemoteBrowserPageMissingError(error)) {
          closeMissingRemotePage(pageId)
          return
        }
        const message = error instanceof Error ? error.message : 'Remote browser command failed.'
        setPaneNotice({ kind: 'consequence', text: message })
        onUpdatePageState(browserTab.id, {
          loading: false,
          // Why: validatedUrl is persisted, so redact the Kagi session token like the main-process failure path does.
          loadError: {
            code: 0,
            description: message,
            validatedUrl: redactKagiSessionToken(url ?? browserTab.url)
          }
        })
      } finally {
        if (isCurrentRemoteOperationToken(pageToken)) {
          setPaneBusy(false)
        }
      }
    },
    [
      applyRemoteTabInfo,
      browserTab.id,
      browserTab.url,
      createRemoteOperationToken,
      lifecycle,
      closeMissingRemotePage,
      isCurrentRemoteOperationToken,
      onUpdatePageState,
      runtimeTarget,
      runtimeWorktree,
      setPaneBusy,
      setPaneNotice,
      stagedPage
    ]
  )

  const navigateToUrl = useCallback(
    (url: string): void => {
      void runRemoteNavigation('browser.goto', url)
    },
    [runRemoteNavigation]
  )

  // Browser history shortcuts for SSH/runtime browsers.
  // Why: remote panes have no local webview ref, so route history through runtime RPC instead of WebContents.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const method = keybindingMatchesAction('browser.back', e, shortcutPlatform, keybindings)
        ? 'browser.back'
        : keybindingMatchesAction('browser.forward', e, shortcutPlatform, keybindings)
          ? 'browser.forward'
          : null
      if (method === null) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      void runRemoteNavigation(method)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings, runRemoteNavigation])

  const submitAddressBar = (): void => {
    // A typed workspace path converts this page to its client-local document preview instead of
    // navigating the remote guest — a runtime-owned tab is where a paired reader actually types.
    const consumedAsWorkspaceDoc = routeWorkspaceDocAddressSubmission({
      worktreeId: browserTab.worktreeId,
      pageId: browserTab.id,
      value: addressBarValue,
      onLoadError: (loadError) => {
        setPaneNotice({ kind: 'direct', text: loadError.description })
        onUpdatePageState(browserTab.id, { loadError })
      }
    })
    if (consumedAsWorkspaceDoc) {
      return
    }
    const submission = resolveBrowserAddressBarSubmission(addressBarValue, { allowFileUrls: false })
    if (submission.status === 'invalid') {
      // 'direct': the only response to what the user just typed. With an empty address bar no
      // load-error overlay renders either, so outranking this would make Enter do nothing visible.
      setPaneNotice({ kind: 'direct', text: submission.loadError.description })
      onUpdatePageState(browserTab.id, { loadError: submission.loadError })
      return
    }
    navigateToUrl(submission.url)
  }

  return {
    applyRemoteTabInfo,
    scheduleRemoteTabInfoRefresh,
    runRemoteNavigation,
    navigateToUrl,
    submitAddressBar
  }
}
