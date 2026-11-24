import { runRemoteBrowserNavigationCommand } from './remote-browser-page-navigation-command'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { isRemoteBrowserPageMissingError } from './remote-browser-stream-errors'
import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import { redactKagiSessionToken } from '../../../../../shared/browser/navigation/browser-url'
import { browserNavigationLeavesFaviconOrigin } from '../../../../../shared/browser/browser-favicon-url'
import { normalizeBrowserHistoryUrl } from '../../../../../shared/workspace-session/workspace-session-browser-history'
import { resolveBrowserAddressBarSubmission } from '../navigate/browser-address-bar-navigation'
import { routeWorkspaceDocAddressSubmission } from '../navigate/workspace-doc-address-submission'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  BrowserPageUrlSetter,
  BrowserPageStateWriter
} from '../describe-page/browser-page-types'
import { getBrowserDisplayTitle, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageNavigation({
  browserTab,
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
  onUpdatePageState: BrowserPageStateWriter
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  setPaneBusy: (busy: boolean) => void
}): {
  applyRemoteTabInfo: (tab: BrowserTabInfo) => void
  /** Ends the in-flight action's claim on the pane, whose RPC may outlive the load it started. */
  abandonRemoteNavigation: () => void
  stopRemotePage: () => Promise<void>
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  runRemoteNavigation: (
    method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
    url?: string,
    ignoreCache?: boolean
  ) => Promise<void>
  navigateToUrl: (url: string) => void
  submitAddressBar: () => void
} {
  const addBrowserHistoryEntry = useAppStore((state) => state.addBrowserHistoryEntry)
  const lastFiledHistoryRef = useRef<string | null>(null)
  const navigationSequence = useRef(0)

  const applyRemoteTabMetadata = useCallback(
    (
      tab: Pick<BrowserTabInfo, 'url' | 'title'> & Partial<Pick<BrowserTabInfo, 'loadError'>>
    ): void => {
      const safeUrl = redactKagiSessionToken(tab.url || 'about:blank')
      const title = getBrowserDisplayTitle(tab.title, safeUrl)
      const page = useAppStore
        .getState()
        .browserPagesByWorkspace[browserTab.workspaceId]?.find(
          (entry) => entry.id === browserTab.id
        )
      if (page?.url !== safeUrl) {
        onSetUrl(browserTab.id, safeUrl, { preserveLoadError: true })
      }
      onUpdatePageState(browserTab.id, {
        title,
        loading: false,
        // Like local pages: the old site's icon must not ride along until the host sends the new one.
        ...(page && page.url !== safeUrl && browserNavigationLeavesFaviconOrigin(page.url, safeUrl)
          ? { faviconUrl: null }
          : {}),
        ...(tab.loadError !== undefined ? { loadError: tab.loadError } : {})
      })
      // File remote navigations in client suggestion history only when URL/title changes; post-input tab reads must not rewrite the store.
      const filing = `${normalizeBrowserHistoryUrl(safeUrl)}\n${title}`
      if (filing !== lastFiledHistoryRef.current) {
        lastFiledHistoryRef.current = filing
        // The host's icon belongs to this document only once the page already shows its URL.
        addBrowserHistoryEntry(safeUrl, title, page?.url === safeUrl ? page.faviconUrl : undefined)
      }
      setAddressBarValueFromPage(toDisplayUrl(safeUrl))
    },
    [
      addBrowserHistoryEntry,
      browserTab.id,
      browserTab.workspaceId,
      onSetUrl,
      onUpdatePageState,
      setAddressBarValueFromPage
    ]
  )

  const applyRemoteTabInfo = useCallback(
    (tab: BrowserTabInfo): void => {
      applyRemoteTabMetadata({ ...tab, loadError: tab.loadError ?? null })
      useAppStore
        .getState()
        .setBrowserPageCertificateFailure(browserTab.id, tab.certificateFailure ?? null)
    },
    [applyRemoteTabMetadata, browserTab.id]
  )

  const abandonRemoteNavigation = useCallback((): void => {
    navigationSequence.current += 1
    const token = createRemoteOperationToken()
    if (token) {
      lifecycle.session.setPageLoading(token, false, onUpdatePageState)
    }
    lifecycle.session.invalidateTabInfoReads()
    setPaneBusy(false)
    setPaneNotice(null)
  }, [createRemoteOperationToken, lifecycle, onUpdatePageState, setPaneBusy, setPaneNotice])

  const stopRemotePage = useCallback(async (): Promise<void> => {
    const target = runtimeTarget()
    if (!target || stagedPage) {
      return
    }
    abandonRemoteNavigation()
    // Only a page the host already has can be stopped; resolving one here could create it.
    const pageId = lifecycle.tokens.remotePage
    const token = pageId ? createRemoteOperationToken(pageId) : null
    if (!pageId || !token) {
      return
    }
    try {
      await callRuntimeRpc(
        target,
        'browser.stop',
        { worktree: runtimeWorktree, page: pageId },
        { timeoutMs: 10_000, suppressFeatureInteraction: true }
      )
      // Read the stopped page's state; the session ignores the read if anything newer lands first.
      await lifecycle.session.refreshTabInfo(token)
    } catch (error) {
      if (!isCurrentRemoteOperationToken(token)) {
        return
      }
      if (isRemoteBrowserPageMissingError(error)) {
        closeMissingRemotePage(pageId)
        return
      }
      setPaneNotice({
        kind: 'consequence',
        text: error instanceof Error ? error.message : 'Remote browser command failed.'
      })
    }
  }, [
    abandonRemoteNavigation,
    closeMissingRemotePage,
    createRemoteOperationToken,
    isCurrentRemoteOperationToken,
    lifecycle,
    runtimeTarget,
    runtimeWorktree,
    setPaneNotice,
    stagedPage
  ])

  const scheduleRemoteTabInfoRefresh = useCallback(
    (token: RemoteBrowserOperationToken, delayMs = 250): void => {
      lifecycle.session.scheduleTabInfoRefresh(token, delayMs)
    },
    [lifecycle]
  )

  const runRemoteNavigation = useCallback(
    async (
      method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
      url?: string,
      ignoreCache?: boolean
    ) => {
      return runRemoteBrowserNavigationCommand(
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
          applyRemoteTabMetadata
        },
        method,
        url,
        ignoreCache
      )
    },
    [
      applyRemoteTabMetadata,
      browserTab,
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

  const submitAddressBar = (): void => {
    // Typed workspace paths convert the local preview rather than navigating the runtime guest.
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
      // Direct validation is the only visible response to an empty submission, so it must outrank stream failures.
      setPaneNotice({ kind: 'direct', text: submission.loadError.description })
      onUpdatePageState(browserTab.id, { loadError: submission.loadError })
      return
    }
    navigateToUrl(submission.url)
  }

  return {
    applyRemoteTabInfo,
    abandonRemoteNavigation,
    stopRemotePage,
    scheduleRemoteTabInfoRefresh,
    runRemoteNavigation,
    navigateToUrl,
    submitAddressBar
  }
}
