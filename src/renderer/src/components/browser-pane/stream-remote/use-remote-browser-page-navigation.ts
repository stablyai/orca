import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import {
  normalizeBrowserNavigationUrl,
  redactKagiSessionToken
} from '../../../../../shared/browser-url'
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
import {
  consumeBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from '../host-guest/browser-focus'
import type { BrowserPageUrlSetter, BrowserTabPageState } from '../describe-page/browser-page-types'
import { getBrowserDisplayTitle, toDisplayUrl } from '../describe-page/browser-page-url-display'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

export function useRemoteBrowserPageNavigation({
  browserTab,
  isActive,
  addressBarInputRef,
  imageRef,
  remoteViewportRef,
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
  addressBarInputRef: React.RefObject<HTMLInputElement | null>
  imageRef: React.RefObject<HTMLImageElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
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
  addressBarValue: string
  setAddressBarValue: (value: string) => void
  applyRemoteTabInfo: (tab: Pick<BrowserTabInfo, 'url' | 'title'>) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  runRemoteNavigation: (
    method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
    url?: string
  ) => Promise<void>
  navigateToUrl: (url: string) => void
  submitAddressBar: () => void
} {
  const [addressBarValue, setAddressBarValue] = useState(toDisplayUrl(browserTab.url))
  const keybindings = useAppStore((state) => state.keybindings)

  useEffect(() => {
    if (document.activeElement === addressBarInputRef.current) {
      return
    }
    setAddressBarValue(toDisplayUrl(browserTab.url))
  }, [addressBarInputRef, browserTab.url])

  const applyRemoteTabInfo = useCallback(
    (tab: Pick<BrowserTabInfo, 'url' | 'title'>): void => {
      const safeUrl = redactKagiSessionToken(tab.url || 'about:blank')
      onSetUrl(browserTab.id, safeUrl)
      onUpdatePageState(browserTab.id, {
        title: getBrowserDisplayTitle(tab.title, safeUrl),
        loading: false,
        loadError: null
      })
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(toDisplayUrl(safeUrl))
      }
    },
    [addressBarInputRef, browserTab.id, onSetUrl, onUpdatePageState]
  )

  const scheduleRemoteTabInfoRefresh = useCallback(
    (token: RemoteBrowserOperationToken, delayMs = 250): void => {
      lifecycle.session.scheduleTabInfoRefresh(token, delayMs)
    },
    [lifecycle]
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(() => {
      addressBarInputRef.current?.focus()
      addressBarInputRef.current?.select()
    })
  }, [addressBarInputRef, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleBrowserFocusRequest = (event: Event): void => {
      const detail = (event as CustomEvent<BrowserFocusRequestDetail>).detail
      if (!detail || detail.pageId !== browserTab.id) {
        return
      }
      const focusTarget = consumeBrowserFocusRequest(browserTab.id)
      if (!focusTarget) {
        return
      }
      if (focusTarget === 'address-bar') {
        addressBarInputRef.current?.focus()
        addressBarInputRef.current?.select()
        return
      }
      const target = imageRef.current ?? remoteViewportRef.current
      target?.focus()
    }
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () =>
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
  }, [addressBarInputRef, browserTab.id, imageRef, isActive, remoteViewportRef])

  const runRemoteNavigation = useCallback(
    async (
      method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
      url?: string
    ) => {
      const target = runtimeTarget()
      if (!target) {
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
      setPaneNotice
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
    const searchEngine = useAppStore.getState().browserDefaultSearchEngine
    const kagiSessionLink = useAppStore.getState().browserKagiSessionLink
    const nextUrl = normalizeBrowserNavigationUrl(addressBarValue, searchEngine, {
      kagiSessionLink
    })
    if (!nextUrl) {
      const message = 'Enter a valid http(s) or localhost URL.'
      // 'direct': the only response to what the user just typed. With an empty address bar no
      // load-error overlay renders either, so outranking this would make Enter do nothing visible.
      setPaneNotice({ kind: 'direct', text: message })
      onUpdatePageState(browserTab.id, {
        loadError: {
          code: 0,
          description: message,
          validatedUrl: redactKagiSessionToken(addressBarValue.trim()) || 'about:blank'
        }
      })
      return
    }
    navigateToUrl(nextUrl)
  }

  return {
    addressBarValue,
    setAddressBarValue,
    applyRemoteTabInfo,
    scheduleRemoteTabInfoRefresh,
    runRemoteNavigation,
    navigateToUrl,
    submitAddressBar
  }
}
