/* eslint-disable max-lines */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Copy,
  Crosshair,
  ExternalLink,
  Globe,
  Image,
  Loader2,
  OctagonX,
  RefreshCw,
  SquareCode
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAppStore } from '@/store'
import { ORCA_BROWSER_BLANK_URL, ORCA_BROWSER_PARTITION } from '../../../../shared/constants'
import type {
  BrowserLoadError,
  BrowserPage as BrowserPageState,
  BrowserWorkspace as BrowserWorkspaceState
} from '../../../../shared/types'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl
} from '../../../../shared/browser-url'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import {
  consumeEvictedBrowserTab,
  markEvictedBrowserTab,
  rememberLiveBrowserUrl
} from './browser-runtime'
import {
  destroyPersistentWebview,
  getHiddenContainer,
  MAX_PARKED_WEBVIEWS,
  parkedAtByTabId,
  registeredWebContentsIds,
  webviewRegistry
} from './webview-registry'
import type {
  BrowserDownloadRequestedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadFinishedEvent
} from '../../../../shared/browser-guest-events'
import type {
  BrowserGrabPayload,
  BrowserGrabScreenshot
} from '../../../../shared/browser-grab-types'
import { useGrabMode } from './useGrabMode'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import { isEditableKeyboardTarget } from './browser-keyboard'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import BrowserFind from './BrowserFind'
import {
  consumeBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from './browser-focus'
import {
  formatByteCount,
  formatDownloadFinishedNotice,
  formatLoadFailureDescription,
  formatLoadFailureRecoveryHint,
  formatPermissionNotice,
  formatPopupNotice
} from './browser-notices'

type BrowserTabPageState = Partial<
  Pick<
    BrowserPageState,
    'title' | 'loading' | 'faviconUrl' | 'canGoBack' | 'canGoForward' | 'loadError'
  >
>

type BrowserDownloadState = BrowserDownloadRequestedEvent & {
  receivedBytes: number
  status: 'requested' | 'downloading'
}

const EMPTY_BROWSER_PAGES: BrowserPageState[] = []

function buildLoadError(event: {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
}): BrowserLoadError {
  return {
    code: event.errorCode ?? -1,
    description: event.errorDescription ?? 'Unknown load failure',
    validatedUrl: event.validatedURL ?? 'about:blank'
  }
}

function toDisplayUrl(url: string): string {
  return url === ORCA_BROWSER_BLANK_URL ? 'about:blank' : url
}

function getBrowserDisplayTitle(title: string | null | undefined, url: string): string {
  if (
    url === 'about:blank' ||
    url === ORCA_BROWSER_BLANK_URL ||
    title === 'about:blank' ||
    title === ORCA_BROWSER_BLANK_URL ||
    !title
  ) {
    return 'New Tab'
  }
  return title
}

function isChromiumErrorPage(url: string): boolean {
  return url.startsWith('chrome-error://')
}

function getLoadErrorMetadata(loadError: BrowserLoadError | null): {
  displayUrl: string
  host: string | null
  isLocalhostLike: boolean
} {
  const rawUrl = loadError?.validatedUrl ?? 'about:blank'
  const displayUrl = toDisplayUrl(rawUrl)
  try {
    const parsed = new URL(rawUrl)
    const host = parsed.host || null
    const hostname = parsed.hostname
    const isLocalhostLike =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1'
    return { displayUrl, host, isLocalhostLike }
  } catch {
    return { displayUrl, host: null, isLocalhostLike: false }
  }
}

function getOpenableExternalUrl(
  webview: Electron.WebviewTag | null,
  fallbackUrl: string
): string | null {
  let currentUrl = fallbackUrl
  if (webview) {
    try {
      currentUrl = webview.getURL() || fallbackUrl
    } catch {
      // Why: restored browser tabs render before the guest emits dom-ready.
      // Electron throws if toolbar code queries navigation state too early, and
      // that renderer exception blanks the whole IDE on launch. Fall back to the
      // persisted tab URL until the guest is fully attached.
      currentUrl = fallbackUrl
    }
  }
  return normalizeExternalBrowserUrl(currentUrl)
}

function getCurrentBrowserUrl(webview: Electron.WebviewTag | null, fallbackUrl: string): string {
  let currentUrl = fallbackUrl
  if (webview) {
    try {
      currentUrl = webview.getURL() || fallbackUrl
    } catch {
      // Why: toolbar actions still need a stable URL during early guest attach
      // and restore. Fall back to the persisted tab URL instead of throwing
      // and dropping browser actions on freshly restored tabs.
      currentUrl = fallbackUrl
    }
  }
  return toDisplayUrl(currentUrl)
}

function retryBrowserTabLoad(
  webview: Electron.WebviewTag | null,
  browserTab: BrowserPageState,
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
): void {
  if (!webview) {
    return
  }

  const retryUrl = normalizeBrowserNavigationUrl(
    browserTab.loadError?.validatedUrl ?? browserTab.url
  )
  if (!retryUrl) {
    return
  }

  // Why: once Chromium lands on chrome-error://chromewebdata/, reload() can
  // simply refresh the internal error page instead of retrying the original
  // destination. Force navigation back to the attempted URL so Retry and the
  // toolbar reload button actually re-attempt the failed page. Keep the last
  // failure visible until a real success arrives so retry does not briefly
  // drop the user back to a blank black guest surface.
  onUpdatePageState(browserTab.id, {
    loading: true,
    title: retryUrl
  })
  webview.src = retryUrl
}

function evictParkedWebviews(excludedTabId: string | null = null): void {
  if (webviewRegistry.size <= MAX_PARKED_WEBVIEWS) {
    return
  }

  const hidden = getHiddenContainer()
  const parkedBrowserTabIds = [...webviewRegistry.entries()]
    .filter(
      ([browserTabId, webview]) =>
        browserTabId !== excludedTabId && webview.parentElement === hidden
    )
    .sort((a, b) => (parkedAtByTabId.get(a[0]) ?? 0) - (parkedAtByTabId.get(b[0]) ?? 0))
    .map(([browserTabId]) => browserTabId)

  while (webviewRegistry.size > MAX_PARKED_WEBVIEWS && parkedBrowserTabIds.length > 0) {
    const browserTabId = parkedBrowserTabIds.shift()
    if (browserTabId) {
      // Why: browser tabs are persistent for fast switching, but hidden guests
      // cannot grow without bound or long Orca sessions accumulate Chromium
      // processes and GPU surfaces. Evict only parked webviews, never the
      // currently visible guest. Remember the eviction so the next mount can
      // explain why an older tab had to reload instead of silently losing state.
      markEvictedBrowserTab(browserTabId)
      destroyPersistentWebview(browserTabId)
    }
  }
}

export default function BrowserPane({
  browserTab,
  isActive
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
}): React.JSX.Element {
  const browserPagesByWorkspace = useAppStore((s) => s.browserPagesByWorkspace)
  const browserPages = browserPagesByWorkspace[browserTab.id] ?? EMPTY_BROWSER_PAGES
  const activeBrowserPage =
    browserPages.find((page) => page.id === browserTab.activePageId) ?? browserPages[0] ?? null
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {activeBrowserPage ? (
        <div className="relative flex min-h-0 flex-1">
          <BrowserPagePane
            browserTab={activeBrowserPage}
            workspaceId={browserTab.id}
            worktreeId={browserTab.worktreeId}
            sessionProfileId={browserTab.sessionProfileId ?? null}
            isActive={isActive}
            onUpdatePageState={updateBrowserPageState}
            onSetUrl={setBrowserPageUrl}
          />
        </div>
      ) : null}
    </div>
  )
}

function BrowserPagePane({
  browserTab,
  workspaceId,
  worktreeId,
  sessionProfileId,
  isActive,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  isActive: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: (tabId: string, url: string) => void
}): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const browserTabIdRef = useRef(browserTab.id)
  browserTabIdRef.current = browserTab.id
  const faviconUrlRef = useRef<string | null>(browserTab.faviconUrl)
  const initialBrowserUrlRef = useRef(browserTab.url)
  const browserTabUrlRef = useRef(browserTab.url)
  const activeLoadFailureRef = useRef<BrowserLoadError | null>(browserTab.loadError)
  // Why: CDP viewport emulation does not survive all renderer process swaps
  // (cross-origin navigations, crashes). We reapply on every dom-ready from
  // this ref so the persisted preset survives reloads without re-running the
  // webview lifecycle effect whenever the preset changes.
  const viewportPresetIdRef = useRef(browserTab.viewportPresetId ?? null)
  viewportPresetIdRef.current = browserTab.viewportPresetId ?? null
  const trackNextLoadingEventRef = useRef(false)
  // Why: tracks the most recent URL the webview has navigated to or been
  // observed at, from any source (navigation events, address bar, initial
  // load). The URL sync effect checks this ref to avoid force-navigating
  // the webview to an intermediate redirect URL — which would restart the
  // redirect chain and cause an infinite loop.
  const lastKnownWebviewUrlRef = useRef<string | null>(null)
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const onSetUrlRef = useRef(onSetUrl)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const addBrowserHistoryEntryRef = useRef(addBrowserHistoryEntry)
  const [addressBarValue, setAddressBarValue] = useState(browserTab.url)
  const addressBarValueRef = useRef(browserTab.url)
  const [resourceNotice, setResourceNotice] = useState<string | null>(null)
  const [downloadState, setDownloadState] = useState<BrowserDownloadState | null>(null)
  const downloadStateRef = useRef<BrowserDownloadState | null>(null)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    linkUrl: string | null
    pageUrl: string
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const grab = useGrabMode(browserTab.id)
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : null
  const webviewPartition = sessionProfile?.partition ?? ORCA_BROWSER_PARTITION
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const clearBrowserSessionImportState = useAppStore((s) => s.clearBrowserSessionImportState)

  useEffect(() => {
    if (!browserSessionImportState) {
      return
    }
    if (browserSessionImportState.status === 'success' && browserSessionImportState.summary) {
      const { importedCookies, domains } = browserSessionImportState.summary
      const domainPreview = domains.slice(0, 3).join(', ')
      const more = domains.length > 3 ? ` +${domains.length - 3} more` : ''
      setResourceNotice(
        `Imported ${importedCookies} cookies for ${domainPreview}${more}. Reload the page to use them.`
      )
      clearBrowserSessionImportState()
    } else if (browserSessionImportState.status === 'error' && browserSessionImportState.error) {
      setResourceNotice(`Cookie import failed: ${browserSessionImportState.error}`)
      clearBrowserSessionImportState()
    }
  }, [browserSessionImportState, clearBrowserSessionImportState])

  useEffect(() => {
    if (!resourceNotice) {
      return
    }
    const timer = setTimeout(() => setResourceNotice(null), 10_000)
    return () => clearTimeout(timer)
  }, [resourceNotice])

  const keepAddressBarFocusRef = useRef(false)

  // Inline toast that appears near the grabbed element instead of the global
  // bottom-right toaster, so feedback feels spatially connected to the action.
  // Why: positioned below (or above, if near viewport bottom) so it doesn't
  // occlude the element the user just selected.
  const [grabToast, setGrabToast] = useState<{
    message: string
    type: 'success' | 'error'
    x: number
    y: number
    below: boolean
    payload: BrowserGrabPayload | null
  } | null>(null)
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Why: clear the toast auto-dismiss timer on unmount so it cannot fire
  // after the component is destroyed (prevents setState-on-unmounted warnings
  // and stale rearm calls).
  useEffect(() => {
    return () => clearTimeout(grabToastTimerRef.current)
  }, [])

  const grabRef = useRef(grab)
  grabRef.current = grab

  const dismissGrabToast = useCallback(() => {
    clearTimeout(grabToastTimerRef.current)
    setGrabToast(null)
    // Why: only rearm if the grab state is still 'confirming', meaning the
    // auto-copy toast is dismissing naturally. If the user already triggered
    // a shortcut (C/S) that called rearm, the state will be 'armed' and we
    // skip to avoid a double-rearm race.
    if (grabRef.current.state === 'confirming') {
      grabRef.current.rearm()
    }
  }, [])

  const showGrabToast = useCallback(
    (message: string, type: 'success' | 'error', payload?: BrowserGrabPayload | null) => {
      let x = 0
      let y = 0
      let below = true
      const containerRect = containerRef.current?.getBoundingClientRect()
      if (payload) {
        const rect = payload.target.rectViewport
        const webview = webviewRef.current
        const webviewRect = webview?.getBoundingClientRect()
        const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
        const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
        x = offsetX + rect.x + rect.width / 2
        const elementBottom = offsetY + rect.y + rect.height
        const elementTop = offsetY + rect.y
        const containerHeight = containerRect?.height ?? 0
        // Show below the element unless it's too close to the bottom edge
        below = elementBottom + 52 < containerHeight
        y = below ? elementBottom : elementTop
      } else if (containerRect) {
        x = containerRect.width / 2
        y = containerRect.height / 2
      }
      clearTimeout(grabToastTimerRef.current)
      setGrabToast({ message, type, x, y, below, payload: payload ?? null })
      grabToastTimerRef.current = setTimeout(() => dismissGrabToast(), 2000)
    },
    [dismissGrabToast]
  )

  // Why: auto-copy element context when the user left-clicks to select in
  // grab mode. One-click-to-copy is the primary action. Right-click
  // (contextMenu=true) skips auto-copy and shows the full action dropdown
  // so the user can choose between copy and screenshot.
  useEffect(() => {
    if (grab.state === 'confirming' && grab.payload && !grab.contextMenu) {
      const text = formatGrabPayloadAsText(grab.payload)
      void window.api.ui.writeClipboardText(text)
      showGrabToast('Copied', 'success', grab.payload)
    }
  }, [grab.state, grab.payload, grab.contextMenu, showGrabToast])

  useEffect(() => {
    initialBrowserUrlRef.current = browserTab.url
  }, [browserTab.id, browserTab.url])

  useEffect(() => {
    // Why: if the user is actively typing in the address bar (focused), do not
    // clobber their in-progress query when an async URL update lands (e.g., the
    // configured default URL resolving after a new tab opens). Syncing will
    // resume on the next legitimate URL change after the input loses focus.
    if (document.activeElement === addressBarInputRef.current) {
      return
    }
    setAddressBarValue(toDisplayUrl(browserTab.url))
  }, [browserTab.url])

  useEffect(() => {
    browserTabUrlRef.current = browserTab.url
  }, [browserTab.url])

  useEffect(() => {
    activeLoadFailureRef.current = browserTab.loadError
  }, [browserTab.loadError])

  useEffect(() => {
    addressBarValueRef.current = addressBarValue
  }, [addressBarValue])

  useEffect(() => {
    downloadStateRef.current = downloadState
  }, [downloadState])

  useEffect(() => {
    setResourceNotice(
      consumeEvictedBrowserTab(browserTab.id)
        ? 'This tab reloaded to free browser resources.'
        : null
    )
    setDownloadState(null)
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onPermissionDenied((event) => {
      if (event.browserPageId !== browserTab.id) {
        return
      }
      setResourceNotice(formatPermissionNotice(event))
    })
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onPopup((event) => {
      if (event.browserPageId !== browserTab.id) {
        return
      }
      setResourceNotice(formatPopupNotice(event))
    })
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onContextMenuRequested((event) => {
      if (event.browserPageId !== browserTab.id) {
        return
      }
      // Why: convert the OS screen cursor position to the renderer's CSS
      // viewport coordinates. This is the only approach immune to coordinate
      // space mismatches between the guest process and the renderer (caused
      // by UI zoom, DPI scaling, or Electron version differences).
      // window.screenX/Y gives the window origin in the same screen
      // coordinate system that screen.getCursorScreenPoint() uses. Dividing
      // by the zoom factor converts screen points to CSS pixels.
      const zoomFactor = Math.pow(1.2, window.api.ui.getZoomLevel())
      const x = Math.round((event.screenX - window.screenX) / zoomFactor)
      const y = Math.round((event.screenY - window.screenY) / zoomFactor)
      console.debug(
        '[context-menu] screen=(%d,%d) window=(%d,%d) zoom=%.2f → viewport=(%d,%d)',
        event.screenX,
        event.screenY,
        window.screenX,
        window.screenY,
        zoomFactor,
        x,
        y
      )
      setContextMenu({
        x,
        y,
        linkUrl: event.linkUrl,
        pageUrl: event.pageUrl
      })
    })
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onContextMenuDismissed((event) => {
      if (event.browserPageId !== browserTab.id) {
        return
      }
      setContextMenu(null)
    })
  }, [browserTab.id])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setContextMenu(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [contextMenu])

  // Why: position: fixed can be offset by ancestor CSS properties (backdrop-filter,
  // transform, will-change) that create new containing blocks. Even with a Portal to
  // document.body, global CSS or Electron chrome can shift the element. Measuring the
  // actual rendered position and correcting before paint is immune to all of these.
  // Additionally, flip the menu when it would overflow the viewport edge so right-clicking
  // near the screen border keeps the entire menu visible.
  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el || !contextMenu) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()

    // Why: CSS containing blocks can shift "fixed" elements. Capture the offset
    // between where we asked CSS to place the element and where it actually rendered.
    const offsetX = contextMenu.x - rect.left
    const offsetY = contextMenu.y - rect.top

    let renderX = contextMenu.x
    let renderY = contextMenu.y

    // Flip so the opposite corner aligns with the cursor when the menu overflows.
    if (rect.right > window.innerWidth) {
      renderX = contextMenu.x - rect.width
    }
    if (rect.bottom > window.innerHeight) {
      renderY = contextMenu.y - rect.height
    }

    renderX = Math.max(0, renderX)
    renderY = Math.max(0, renderY)

    el.style.left = `${renderX + offsetX}px`
    el.style.top = `${renderY + offsetY}px`
  }, [contextMenu])

  useEffect(() => {
    return window.api.browser.onDownloadRequested((event) => {
      if (event.browserPageId !== browserTab.id) {
        return
      }
      // Why: downloads are approved per browser tab, not globally. Keep the
      // request local to the owning BrowserPane so the user can see which page
      // triggered the save prompt before Orca asks main to choose a path.
      setDownloadState({
        ...event,
        receivedBytes: 0,
        status: 'requested'
      })
      setResourceNotice(null)
    })
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onDownloadProgress((event: BrowserDownloadProgressEvent) => {
      setDownloadState((current) => {
        if (!current || current.downloadId !== event.downloadId) {
          return current
        }
        return {
          ...current,
          receivedBytes: event.receivedBytes,
          totalBytes: event.totalBytes,
          status: 'downloading'
        }
      })
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onDownloadFinished((event: BrowserDownloadFinishedEvent) => {
      const current = downloadStateRef.current
      if (!current || current.downloadId !== event.downloadId) {
        return
      }
      setDownloadState((current) => {
        if (!current || current.downloadId !== event.downloadId) {
          return current
        }
        return null
      })
      setResourceNotice(formatDownloadFinishedNotice(event))
    })
  }, [])

  const focusAddressBarNow = useCallback(() => {
    const input = addressBarInputRef.current
    if (!input) {
      return false
    }
    webviewRef.current?.blur()
    input.focus()
    input.select()
    return document.activeElement === input
  }, [])

  const focusWebviewNow = useCallback(() => {
    const webview = webviewRef.current
    if (!webview) {
      return false
    }
    addressBarInputRef.current?.blur()
    webview.focus()
    return document.activeElement === webview
  }, [])

  useEffect(() => {
    if (!consumeAddressBarFocusRequest(browserTab.id)) {
      return
    }
    keepAddressBarFocusRef.current = true
    // Why: terminal activation restores xterm focus on a later animation frame
    // when the surface changes. A single address-bar focus attempt can lose
    // that race, leaving the new browser tab on <body>. Retry briefly across a
    // few frames so a freshly opened blank tab still lands in the location bar,
    // but keep the request one-shot so revisiting the tab later does not steal
    // focus back from the user.
    let cancelled = false
    let frameId = 0
    let attempts = 0
    const focusAddressBar = (): void => {
      if (cancelled) {
        return
      }
      focusAddressBarNow()
      attempts += 1
      if (attempts < 6) {
        frameId = window.requestAnimationFrame(focusAddressBar)
      } else {
        keepAddressBarFocusRef.current = false
      }
    }
    frameId = window.requestAnimationFrame(focusAddressBar)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [browserTab.id, consumeAddressBarFocusRequest, focusAddressBarNow])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(() => {
      focusAddressBarNow()
    })
  }, [focusAddressBarNow, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const focusTarget = consumeBrowserFocusRequest(browserTab.id)
    if (!focusTarget) {
      return
    }
    keepAddressBarFocusRef.current = focusTarget === 'address-bar'
    let cancelled = false
    let frameId = 0
    let attempts = 0
    const runFocus = (): void => {
      if (cancelled) {
        return
      }
      const didFocus = focusTarget === 'address-bar' ? focusAddressBarNow() : focusWebviewNow()
      attempts += 1
      if (!didFocus && attempts < 6) {
        frameId = window.requestAnimationFrame(runFocus)
      }
    }
    // Why: jump-palette browser focus can be queued before the target page
    // pane mounts. Persisting the request outside React lets the active page
    // claim it once mounted instead of depending on a transient event race.
    frameId = window.requestAnimationFrame(runFocus)
    return () => {
      cancelled = true
      window.cancelAnimationFrame(frameId)
    }
  }, [browserTab.id, focusAddressBarNow, focusWebviewNow, isActive])

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
        // Why: palette-triggered address-bar focus has to survive the same
        // follow-up browser load events as the existing blank-tab path.
        keepAddressBarFocusRef.current = true
        focusAddressBarNow()
        return
      }
      keepAddressBarFocusRef.current = false
      focusWebviewNow()
    }
    // Why: queued focus lets a page claim a request after mount, but palette
    // re-selecting an already-active page never remounts. Listening for the
    // matching event lets the active pane consume the durable request
    // immediately without regressing the mount/activation path above.
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () =>
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
  }, [browserTab.id, focusAddressBarNow, focusWebviewNow, isActive])

  // Cmd/Ctrl+F — find in page (renderer path: focus on browser chrome)
  // Why: unlike grab-mode shortcuts (bare C/S) which skip editable targets,
  // Cmd+F is a modified chord that should always open find — even from the
  // address bar. This matches Chrome/Safari behavior.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (!isMod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'f') {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setFindOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive])

  // Cmd/Ctrl+F — find in page (IPC path: focus inside webview guest)
  // Why: a focused webview guest is a separate Chromium process so the renderer
  // keydown handler above never fires. Main intercepts the chord and sends it
  // back here so find works whether focus is on the toolbar or the page.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFindInBrowserPage(() => {
      setFindOpen(true)
    })
  }, [isActive])

  // Close find bar when tab is deactivated
  useEffect(() => {
    if (!isActive) {
      setFindOpen(false)
    }
  }, [isActive])

  // Cmd/Ctrl+R — reload (renderer path: focus on browser chrome, not in guest)
  // Why: when focus is inside the renderer chrome (address bar, toolbar buttons)
  // rather than the webview guest, the guest shortcut forwarding in main never
  // fires. Handle the chord directly here so reload works regardless of where
  // focus sits within the browser pane.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (!isMod || e.altKey || e.key.toLowerCase() !== 'r') {
        return
      }
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) {
        webviewRef.current?.reloadIgnoringCache()
      } else {
        webviewRef.current?.reload()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive])

  // Cmd/Ctrl+R — reload (IPC path: focus inside webview guest)
  // Why: a focused webview guest is a separate Chromium process so the renderer
  // keydown handler above never fires. Main intercepts the chord and sends it
  // back here so reload works whether focus is on the toolbar or the page.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onReloadBrowserPage(() => {
      webviewRef.current?.reload()
    })
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onHardReloadBrowserPage(() => {
      webviewRef.current?.reloadIgnoringCache()
    })
  }, [isActive])

  useEffect(() => {
    onUpdatePageStateRef.current = onUpdatePageState
    onSetUrlRef.current = onSetUrl
    addBrowserHistoryEntryRef.current = addBrowserHistoryEntry
  }, [onSetUrl, onUpdatePageState, addBrowserHistoryEntry])

  const syncNavigationState = useCallback(
    (webview: Electron.WebviewTag): void => {
      try {
        onUpdatePageStateRef.current(browserTab.id, {
          title: getBrowserDisplayTitle(
            webview.getTitle(),
            webview.getURL() || browserTabUrlRef.current
          ),
          // Why: webview reclaim/attach can transiently report isLoading() even
          // when no user-visible navigation happened. If we sync that into the
          // tab model on every activation, switching tabs flashes the blue
          // loading dot and makes parked tabs look like they are reloading.
          // Only explicit navigation/load events should drive Orca's loading UI.
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward()
        })
      } catch {
        // Why: Electron only exposes these getters after the guest fully
        // attaches. Ignoring the transient failure avoids crashing Orca while
        // the parked webview is being reclaimed into the visible tab body.
      }
    },
    [browserTab.id]
  )

  // Why: this effect manages the full lifecycle of the webview DOM element —
  // creation, parking, event wiring, and teardown. browserTab.url is
  // intentionally excluded — it changes on every navigation, and including it
  // would destroy and recreate the webview on every page load. URL-dependent
  // logic inside the effect reads from browserTabUrlRef instead.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  useEffect(() => {
    const container = containerRef.current
    if (!container) {
      return
    }

    let webview = webviewRegistry.get(browserTab.id)
    let needsInitialNavigation = false
    if (webview) {
      container.appendChild(webview)
      parkedAtByTabId.delete(browserTab.id)
      syncNavigationState(webview)
      // Why: seed the ref with the store URL so the URL sync effect does not
      // force-navigate a reclaimed webview that is already on the right page.
      // getURL() can throw briefly during reattach, so use the store URL which
      // was set by the last navigation event before parking.
      lastKnownWebviewUrlRef.current =
        normalizeBrowserNavigationUrl(browserTabUrlRef.current) ?? null
    } else {
      webview = document.createElement('webview') as Electron.WebviewTag
      webview.setAttribute('partition', webviewPartition)
      webview.setAttribute('allowpopups', '')
      webview.style.display = 'flex'
      webview.style.flex = '1'
      webview.style.width = '100%'
      webview.style.height = '100%'
      webview.style.border = 'none'
      // Why: default to white so sites that don't set an html/body background
      // (e.g. httpbin.org/html) don't show through to Orca's dark chrome. Real
      // browsers paint the viewport white by default; sites that specify their
      // own background (including dark ones) still override this.
      webview.style.background = '#ffffff'
      webviewRegistry.set(browserTab.id, webview)
      container.appendChild(webview)
      needsInitialNavigation = true
    }

    webviewRef.current = webview

    const handleDomReady = (): void => {
      const webContentsId = webview.getWebContentsId()
      if (registeredWebContentsIds.get(browserTab.id) !== webContentsId) {
        registeredWebContentsIds.set(browserTab.id, webContentsId)
        void window.api.browser.registerGuest({
          browserPageId: browserTab.id,
          workspaceId,
          worktreeId,
          sessionProfileId,
          webContentsId
        })
      }
      syncNavigationState(webview)
      if (keepAddressBarFocusRef.current) {
        focusAddressBarNow()
      }
      // Why: CDP Emulation.setDeviceMetricsOverride and related overrides are
      // scoped to the guest's debugger session and do not survive all
      // cross-origin navigations (renderer swaps). Reapplying on dom-ready is
      // idempotent, so users who picked a viewport preset keep it after
      // reloads, SPA navigations, and persisted-session restoration.
      const presetId = viewportPresetIdRef.current
      const preset = getBrowserViewportPreset(presetId)
      // Why: always reapply on dom-ready (including null) because
      // Emulation.setDeviceMetricsOverride can persist across same-origin navigations
      // within the same renderer. Sending null ensures CDP matches the store state
      // instead of showing a stale emulated viewport after the user picks "Default".
      void window.api.browser.setViewportOverride({
        browserPageId: browserTab.id,
        override: preset ? browserViewportPresetToOverride(preset) : null
      })
    }

    const handleDidStartLoading = (): void => {
      if (!trackNextLoadingEventRef.current) {
        return
      }
      faviconUrlRef.current = null
      onUpdatePageStateRef.current(browserTab.id, {
        loading: true,
        faviconUrl: null
      })
    }

    const handleDidStopLoading = (): void => {
      const currentUrl = webview.getURL() || webview.src || 'about:blank'
      const activeLoadFailure = activeLoadFailureRef.current
      if (isChromiumErrorPage(currentUrl)) {
        trackNextLoadingEventRef.current = false
        const synthesizedFailure = {
          code: -1,
          description: 'This site could not be reached.',
          validatedUrl: browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
        }
        activeLoadFailureRef.current = synthesizedFailure
        onUpdatePageStateRef.current(browserTab.id, {
          loading: false,
          loadError: synthesizedFailure
        })
        return
      }
      if (activeLoadFailure) {
        const normalizedAttemptedUrl =
          normalizeBrowserNavigationUrl(activeLoadFailure.validatedUrl) ??
          activeLoadFailure.validatedUrl
        const normalizedCurrentUrl = normalizeBrowserNavigationUrl(currentUrl) ?? currentUrl
        if (normalizedAttemptedUrl === normalizedCurrentUrl) {
          trackNextLoadingEventRef.current = false
          // Why: some webview failures still emit did-stop-loading on the
          // original destination URL. If we clear loadError here, the failed
          // navigation falls back to a blank Chromium surface even though Orca
          // already knows this exact load failed.
          onUpdatePageStateRef.current(browserTab.id, {
            loading: false,
            title: getBrowserDisplayTitle(webview.getTitle(), currentUrl),
            faviconUrl: faviconUrlRef.current,
            canGoBack: webview.canGoBack(),
            canGoForward: webview.canGoForward(),
            loadError: activeLoadFailure
          })
          return
        }
      }
      trackNextLoadingEventRef.current = false
      activeLoadFailureRef.current = null
      lastKnownWebviewUrlRef.current = normalizeBrowserNavigationUrl(currentUrl) ?? currentUrl
      rememberLiveBrowserUrl(browserTab.id, currentUrl)
      // Why: don't overwrite in-progress typing. See comment on the
      // browserTab.url sync effect above.
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(toDisplayUrl(currentUrl))
      }
      onSetUrlRef.current(browserTab.id, currentUrl)
      if (keepAddressBarFocusRef.current && currentUrl === ORCA_BROWSER_BLANK_URL) {
        focusAddressBarNow()
      } else {
        keepAddressBarFocusRef.current = false
      }
      onUpdatePageStateRef.current(browserTab.id, {
        loading: false,
        title: getBrowserDisplayTitle(webview.getTitle(), currentUrl),
        faviconUrl: faviconUrlRef.current,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward(),
        loadError: null
      })
    }

    const handleDidNavigate = (event: { url?: string; isMainFrame?: boolean }): void => {
      if (event.isMainFrame === false) {
        return
      }
      const currentUrl = event.url ?? webview.getURL() ?? webview.src ?? 'about:blank'
      if (isChromiumErrorPage(currentUrl)) {
        return
      }
      lastKnownWebviewUrlRef.current = normalizeBrowserNavigationUrl(currentUrl) ?? currentUrl
      rememberLiveBrowserUrl(browserTab.id, currentUrl)
      // Why: don't overwrite in-progress typing (see above).
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(toDisplayUrl(currentUrl))
      }
      onSetUrlRef.current(browserTab.id, currentUrl)
      onUpdatePageStateRef.current(browserTab.id, {
        title: webview.getTitle() || currentUrl,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward()
      })
    }

    const handleTitleUpdate = (event: { title?: string }): void => {
      try {
        const currentUrl = webview.getURL() || browserTab.url
        const title = getBrowserDisplayTitle(event.title, currentUrl)
        onUpdatePageStateRef.current(browserTab.id, { title })
        addBrowserHistoryEntryRef.current(currentUrl, title)
      } catch {
        // Why: title-updated can fire before dom-ready, making getURL() throw.
      }
    }

    const handleFaviconUpdate = (event: { favicons?: string[] }): void => {
      const faviconUrl = event.favicons?.[0] ?? null
      faviconUrlRef.current =
        faviconUrl &&
        (faviconUrl.startsWith('https://') ||
          faviconUrl.startsWith('http://') ||
          faviconUrl.startsWith('data:image/'))
          ? faviconUrl
          : null
      onUpdatePageStateRef.current(browserTab.id, { faviconUrl: faviconUrlRef.current })
    }

    const handleFailLoad = (event: {
      errorCode?: number
      errorDescription?: string
      validatedURL?: string
      isMainFrame?: boolean
    }): void => {
      if (event.isMainFrame === false) {
        return
      }
      if (event.errorCode === -3) {
        // Why: Chromium reports redirect/cancel races as ERR_ABORTED (-3) even
        // when the replacement navigation succeeds. Ignore that noise so Orca
        // does not show a false load failure for a working page.
        return
      }
      trackNextLoadingEventRef.current = false
      const loadError = buildLoadError(event)
      activeLoadFailureRef.current = loadError
      onUpdatePageStateRef.current(browserTab.id, {
        loading: false,
        loadError
      })
    }

    webview.addEventListener('dom-ready', handleDomReady)
    webview.addEventListener('did-start-loading', handleDidStartLoading)
    webview.addEventListener('did-stop-loading', handleDidStopLoading)
    // Why: separate handler registered only on 'did-navigate' (full page loads),
    // NOT on 'did-navigate-in-page'. The shared handleDidNavigate is registered
    // on both events, so adding find-close logic there would also close on SPA
    // hash changes and pushState calls, which fire constantly on single-page apps.
    const handleFindCloseOnNavigate = (): void => {
      setFindOpen(false)
    }

    webview.addEventListener('did-navigate', handleDidNavigate)
    webview.addEventListener('did-navigate', handleFindCloseOnNavigate)
    webview.addEventListener('did-navigate-in-page', handleDidNavigate)
    webview.addEventListener('page-title-updated', handleTitleUpdate)
    webview.addEventListener('page-favicon-updated', handleFaviconUpdate)
    webview.addEventListener('did-fail-load', handleFailLoad)

    if (needsInitialNavigation) {
      // Why: connection-refused localhost tabs can fail before Electron wires up
      // event delivery if src is assigned too early. Attach listeners first so
      // Orca never misses the initial did-fail-load signal for a new tab.
      // Only non-blank initial tabs should light up Orca's loading indicator;
      // reclaiming/activating a parked about:blank tab is not a meaningful
      // navigation and should not flash the tab-loading dot.
      const initialUrl =
        normalizeBrowserNavigationUrl(initialBrowserUrlRef.current) ?? ORCA_BROWSER_BLANK_URL
      trackNextLoadingEventRef.current = initialUrl !== ORCA_BROWSER_BLANK_URL
      lastKnownWebviewUrlRef.current = initialUrl
      webview.src = initialUrl
    }

    return () => {
      webview.removeEventListener('dom-ready', handleDomReady)
      webview.removeEventListener('did-start-loading', handleDidStartLoading)
      webview.removeEventListener('did-stop-loading', handleDidStopLoading)
      webview.removeEventListener('did-navigate', handleDidNavigate)
      webview.removeEventListener('did-navigate', handleFindCloseOnNavigate)
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate)
      webview.removeEventListener('page-title-updated', handleTitleUpdate)
      webview.removeEventListener('page-favicon-updated', handleFaviconUpdate)
      webview.removeEventListener('did-fail-load', handleFailLoad)

      if (webviewRef.current === webview) {
        webviewRef.current = null
      }

      if (webviewRegistry.get(browserTab.id) === webview) {
        getHiddenContainer().appendChild(webview)
        parkedAtByTabId.set(browserTab.id, Date.now())
        evictParkedWebviews(browserTab.id)
      }
    }
    // Why: this effect mounts and wires up webview event listeners once per tab
    // identity. browserTab.url is intentionally excluded: re-running on URL
    // changes would detach/reattach the webview, cancelling in-progress
    // navigations. Callbacks use refs so they always see current values.
    // webviewPartition IS included: switching profiles changes the partition,
    // which requires destroying and recreating the webview since Electron does
    // not allow changing a webview's partition after creation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    browserTab.id,
    webviewPartition,
    workspaceId,
    worktreeId,
    createBrowserTab,
    focusAddressBarNow,
    focusWebviewNow,
    syncNavigationState
  ])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    const normalizedUrl = normalizeBrowserNavigationUrl(browserTab.url)
    if (!normalizedUrl) {
      return
    }
    // Why: navigation events (did-navigate, did-stop-loading) update both the
    // store URL and this ref to the same value. If they match, the store URL
    // change came from a navigation event — not a user action — so there is
    // nothing to navigate to. Skipping here prevents the sync effect from
    // force-navigating the webview back to an intermediate redirect URL, which
    // would restart the redirect chain and cause an infinite loop.
    if (lastKnownWebviewUrlRef.current === normalizedUrl) {
      return
    }
    let liveUrl: string | null = null
    try {
      liveUrl = webview.getURL() || null
    } catch {
      // Why: reattached parked guests can briefly reject getURL() before the
      // underlying guest is fully ready again. Skip entirely so we do not
      // misinterpret a transient error as a URL mismatch and force-navigate.
      return
    }
    const normalizedLiveUrl = liveUrl ? (normalizeBrowserNavigationUrl(liveUrl) ?? liveUrl) : null
    const declaredSrc = webview.getAttribute('src')
    if (
      normalizedLiveUrl !== normalizedUrl &&
      webview.src !== normalizedUrl &&
      declaredSrc !== normalizedUrl
    ) {
      // Why: browserTab.url changes are Orca-driven navigations (address bar,
      // terminal link open, retry target update). Gate the next did-start-loading
      // event so only real navigations, not tab activation churn, show loading UI.
      trackNextLoadingEventRef.current = normalizedUrl !== ORCA_BROWSER_BLANK_URL
      lastKnownWebviewUrlRef.current = normalizedUrl
      webview.src = normalizedUrl
      if (normalizedUrl !== ORCA_BROWSER_BLANK_URL) {
        keepAddressBarFocusRef.current = false
        if (document.activeElement === addressBarInputRef.current) {
          focusWebviewNow()
        }
      }
    }
  }, [browserTab.url, focusWebviewNow])

  useEffect(() => {
    if (!browserTab.loading) {
      return
    }

    const detectChromiumErrorPage = (): void => {
      const webview = webviewRef.current
      if (!webview) {
        return
      }
      try {
        const currentUrl = webview.getURL() || webview.src || ''
        if (!isChromiumErrorPage(currentUrl)) {
          return
        }

        const attemptedUrl = browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
        onUpdatePageStateRef.current(browserTab.id, {
          loading: false,
          loadError: {
            code: -1,
            description: 'This site could not be reached.',
            validatedUrl: attemptedUrl
          }
        })
      } catch {
        // Why: the guest can still be mid-attach while the loading spinner is
        // visible. Polling is only a fallback for missed failure events, so
        // transient getURL() errors should be ignored until the next tick.
      }
    }

    // Why: some Electron builds paint Chromium's internal chrome-error page
    // without delivering a timely did-fail-load event to the renderer webview.
    // Polling only while the tab is "loading" gives Orca a last-resort path to
    // swap the black guest surface for the explicit unreachable-page overlay.
    detectChromiumErrorPage()
    const intervalId = window.setInterval(detectChromiumErrorPage, 250)
    return () => window.clearInterval(intervalId)
  }, [browserTab.id, browserTab.loading])

  // CmdOrCtrl+C toggles grab mode
  // Why: Cmd+C is deliberately repurposed inside the browser pane so that the
  // most natural "copy" gesture enters grab mode, letting the user visually
  // pick and copy an element.  Normal text copy inside the webview guest is
  // handled by the guest page itself (Chromium's built-in Cmd+C) and never
  // reaches the host renderer keydown listener.
  useEffect(() => {
    // Why: without the isActive gate, every mounted BrowserPagePane registers
    // a global keydown listener, so Cmd+C would toggle grab mode on all panes
    // simultaneously — not just the active one.
    if (!isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Why: let native Cmd+C work in text inputs (address bar, search fields,
      // contentEditable regions). Only intercept when focus is on a non-input
      // element so grab-mode toggle doesn't swallow copy in form controls.
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      const isMod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (isMod && !e.shiftKey && e.key.toLowerCase() === 'c') {
        e.preventDefault()
        grab.toggle()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [grab, isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isMod = navigator.userAgent.includes('Mac') ? e.metaKey : e.ctrlKey
      if (!isMod || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'l') {
        return
      }
      // Why: Cmd/Ctrl+L is a browser-local focus command. Capture it before
      // the surrounding workspace or any embedded editor surface can treat the
      // same chord as something else.
      e.preventDefault()
      e.stopPropagation()
      focusAddressBarNow()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [focusAddressBarNow, isActive])

  // Why: a focused webview guest receives Cmd/Ctrl+C inside Chromium, not the
  // host renderer window. Main forwards the chord back only when the page
  // would not use it for native copy, so grab mode still toggles from web
  // content without stealing real copy from inputs or selections.
  useEffect(() => {
    return window.api.browser.onGrabModeToggle((tabId) => {
      if (tabId === browserTab.id) {
        grabRef.current.toggle()
      }
    })
  }, [browserTab.id])

  // Why: single-key shortcuts (C / S) let the user copy the hovered element
  // without clicking. During 'armed'/'awaiting' state, the shortcut calls the
  // extractHoverPayload IPC to read the currently hovered element directly.
  // During 'confirming' state, it uses the already-captured payload instead.
  // The shortcuts only fire when grab mode is active, so they don't interfere
  // with normal typing elsewhere.
  const grabPayloadRef = useRef(grab.payload)
  grabPayloadRef.current = grab.payload
  const handleGrabActionShortcut = useCallback(
    (key: 'c' | 's'): void => {
      const copyFromPayload = (payload: BrowserGrabPayload): void => {
        if (key === 'c') {
          const text = formatGrabPayloadAsText(payload)
          void window.api.ui.writeClipboardText(text)
          showGrabToast('Copied', 'success', payload)
        } else {
          const dataUrl = payload.screenshot?.dataUrl
          if (dataUrl?.startsWith('data:image/png;base64,')) {
            void window.api.ui.writeClipboardImage(dataUrl)
            showGrabToast('Screenshotted', 'success', payload)
          } else {
            showGrabToast('No screenshot available', 'error', payload)
          }
        }
      }

      if (grab.state === 'confirming') {
        // Why: left-click auto-copies, so only S (screenshot) is useful.
        // But right-click (contextMenu) skips auto-copy, so C must still work.
        if (grab.contextMenu && key === 'c') {
          const currentPayload = grabPayloadRef.current
          if (currentPayload) {
            copyFromPayload(currentPayload)
          }
          grab.rearm()
        } else if (key === 's') {
          const currentPayload = grabPayloadRef.current
          if (currentPayload) {
            copyFromPayload(currentPayload)
          }
          grab.rearm()
        }
      } else {
        // armed/awaiting — extract hovered element via IPC without clicking
        void (async () => {
          const result = await window.api.browser.extractHoverPayload({
            browserPageId: browserTabIdRef.current
          })
          if (!result.ok) {
            showGrabToast('No element hovered', 'error')
            return
          }
          const payload = result.payload as BrowserGrabPayload

          if (key === 's') {
            try {
              const ssResult = await window.api.browser.captureSelectionScreenshot({
                browserPageId: browserTabIdRef.current,
                rect: payload.target.rectViewport
              })
              if (ssResult.ok) {
                payload.screenshot = ssResult.screenshot as BrowserGrabScreenshot
              }
            } catch {
              // Screenshot failure is non-fatal for the copy flow
            }
          }

          copyFromPayload(payload)
        })()
      }
    },
    [grab, showGrabToast]
  )

  useEffect(() => {
    if (grab.state === 'idle' || grab.state === 'error') {
      return
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      // Ignore if modifier keys are held — user may be doing Cmd+C etc.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return
      }
      const key = e.key.toLowerCase()
      if (key !== 'c' && key !== 's') {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      handleGrabActionShortcut(key as 'c' | 's')
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [grab.state, handleGrabActionShortcut])

  useEffect(() => {
    if (grab.state === 'idle' || grab.state === 'error') {
      return
    }
    return window.api.browser.onGrabActionShortcut(({ browserPageId, key }) => {
      if (browserPageId !== browserTab.id) {
        return
      }
      handleGrabActionShortcut(key)
    })
  }, [browserTab.id, grab.state, handleGrabActionShortcut])

  // Why: Radix DropdownMenu fires onOpenChange(false) before onSelect, so
  // the rearm in onOpenChange would clear the payload before the handler runs.
  // This ref lets onOpenChange skip the rearm when a menu action was taken.
  const grabMenuActionTakenRef = useRef(false)

  // Handlers for the right-click context dropdown menu
  const handleGrabCopy = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    const text = formatGrabPayloadAsText(payload)
    void window.api.ui.writeClipboardText(text)
    showGrabToast('Copied', 'success', payload)
    grab.rearm()
  }, [grab, showGrabToast])

  const handleGrabCopyScreenshot = useCallback(() => {
    grabMenuActionTakenRef.current = true
    const payload = grabPayloadRef.current
    if (!payload) {
      return
    }
    const dataUrl = payload.screenshot?.dataUrl
    if (!dataUrl?.startsWith('data:image/png;base64,')) {
      return
    }
    void window.api.ui.writeClipboardImage(dataUrl)
    showGrabToast('Screenshotted', 'success', payload)
    grab.rearm()
  }, [grab, showGrabToast])

  const navigateToUrl = useCallback(
    (url: string): void => {
      setAddressBarValue(toDisplayUrl(url))
      onSetUrlRef.current(browserTab.id, url)
      onUpdatePageStateRef.current(browserTab.id, {
        loading: true,
        loadError: null,
        title: getBrowserDisplayTitle(url, url)
      })
      setResourceNotice(null)

      const webview = webviewRef.current
      if (!webview) {
        return
      }
      trackNextLoadingEventRef.current = url !== ORCA_BROWSER_BLANK_URL
      lastKnownWebviewUrlRef.current = url
      webview.src = url
      if (url !== ORCA_BROWSER_BLANK_URL) {
        focusWebviewNow()
      }
    },
    [browserTab.id, focusWebviewNow]
  )

  const submitAddressBar = (): void => {
    keepAddressBarFocusRef.current = false
    const searchEngine = useAppStore.getState().browserDefaultSearchEngine
    const nextUrl = normalizeBrowserNavigationUrl(addressBarValue, searchEngine)
    if (!nextUrl) {
      onUpdatePageStateRef.current(browserTab.id, {
        loadError: {
          code: 0,
          description: 'Enter a valid http(s) or localhost URL.',
          validatedUrl: addressBarValue.trim() || 'about:blank'
        }
      })
      return
    }
    navigateToUrl(nextUrl)
  }

  // Why: the store initially holds 'about:blank', but once the webview loads
  // with the safe data: URL, handleDidStopLoading writes the resolved URL back.
  // Match both so the "New Browser Tab" overlay stays visible for blank tabs.
  const isBlankTab = browserTab.url === 'about:blank' || browserTab.url === ORCA_BROWSER_BLANK_URL
  const externalUrl = getOpenableExternalUrl(webviewRef.current, browserTab.url)
  const currentBrowserUrl = getCurrentBrowserUrl(webviewRef.current, browserTab.url)
  const loadErrorMeta = getLoadErrorMetadata(browserTab.loadError)
  const loadErrorHint = formatLoadFailureRecoveryHint(loadErrorMeta)
  const showFailureOverlay = Boolean(browserTab.loadError) && !isBlankTab
  const downloadProgressLabel = (() => {
    if (!downloadState) {
      return null
    }
    const received = formatByteCount(downloadState.receivedBytes)
    const total = formatByteCount(downloadState.totalBytes)
    if (received && total) {
      return `${received} / ${total}`
    }
    if (total) {
      return total
    }
    return received
  })()

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: Electron webviews render in their own compositor layer, so a React
    // overlay can sit "under" a failed guest and still look like a black page.
    // Fully removing the guest from layout is more reliable than visibility
    // toggles here; some Electron builds keep painting a hidden guest layer.
    webview.style.display = showFailureOverlay ? 'none' : 'flex'
  }, [showFailureOverlay])

  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-1 flex-col',
        isActive ? 'z-10' : 'pointer-events-none hidden'
      )}
    >
      {/* IPC-driven context menu — rendered in a Portal so position: fixed is
          relative to the viewport, not affected by ancestor backdrop-filter or
          transform properties that create new containing blocks. */}
      {contextMenu
        ? createPortal(
            <>
              <div className="fixed inset-0 z-50" onPointerDown={() => setContextMenu(null)} />
              <div
                ref={contextMenuRef}
                role="menu"
                data-testid="browser-context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                className="fixed z-50 min-w-[13rem] overflow-hidden rounded-[11px] border border-black/14 bg-[rgba(255,255,255,0.82)] p-1 text-black shadow-[0_16px_36px_rgba(0,0,0,0.24),inset_0_1px_0_rgba(255,255,255,0.14)] backdrop-blur-2xl dark:border-white/14 dark:bg-[rgba(0,0,0,0.72)] dark:text-white dark:shadow-[0_20px_44px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.04)]"
              >
                {contextMenu.linkUrl ? (
                  <>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        createBrowserTab(worktreeId, contextMenu.linkUrl!, {
                          title: contextMenu.linkUrl!
                        })
                        setContextMenu(null)
                      }}
                    >
                      Open Link In Orca Browser
                    </button>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        const targetUrl = normalizeExternalBrowserUrl(contextMenu.linkUrl!)
                        if (targetUrl) {
                          void window.api.shell.openUrl(targetUrl)
                        }
                        setContextMenu(null)
                      }}
                    >
                      Open Link In Default Browser
                    </button>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        void window.api.ui.writeClipboardText(contextMenu.linkUrl ?? '')
                        setContextMenu(null)
                      }}
                    >
                      Copy Link Address
                    </button>
                    <div className="my-1 h-px bg-border/70" />
                  </>
                ) : null}
                <button
                  role="menuitem"
                  disabled={!browserTab.canGoBack}
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14"
                  onClick={() => {
                    webviewRef.current?.goBack()
                    setContextMenu(null)
                  }}
                >
                  Back
                </button>
                <button
                  role="menuitem"
                  disabled={!browserTab.canGoForward}
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 disabled:pointer-events-none disabled:opacity-50 dark:hover:bg-white/14"
                  onClick={() => {
                    webviewRef.current?.goForward()
                    setContextMenu(null)
                  }}
                >
                  Forward
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    webviewRef.current?.reload()
                    setContextMenu(null)
                  }}
                >
                  Reload
                </button>
                <div className="my-1 h-px bg-border/70" />
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    const targetUrl = normalizeExternalBrowserUrl(contextMenu.pageUrl)
                    if (targetUrl) {
                      void window.api.shell.openUrl(targetUrl)
                    }
                    setContextMenu(null)
                  }}
                >
                  Open Page In Default Browser
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void window.api.ui.writeClipboardText(contextMenu.pageUrl)
                    setContextMenu(null)
                  }}
                >
                  Copy Page URL
                </button>
                <div className="my-1 h-px bg-border/70" />
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void window.api.browser.openDevTools({ browserPageId: browserTab.id })
                    setContextMenu(null)
                  }}
                >
                  Inspect Page
                </button>
              </div>
            </>,
            document.body
          )
        : null}

      <div className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => webviewRef.current?.goBack()}
          disabled={!browserTab.canGoBack}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => webviewRef.current?.goForward()}
          disabled={!browserTab.canGoForward}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => {
            const webview = webviewRef.current
            if (!webview) {
              return
            }
            if (browserTab.loading) {
              webview.stop()
            } else if (browserTab.loadError) {
              retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
            } else {
              webview.reload()
            }
          }}
        >
          {browserTab.loading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
        </Button>

        <BrowserAddressBar
          value={addressBarValue}
          onChange={setAddressBarValue}
          onSubmit={submitAddressBar}
          onNavigate={navigateToUrl}
          inputRef={addressBarInputRef}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: wrap the disabled button in a span so pointer events still
                reach the tooltip trigger — Radix (and the DOM) drop hover
                events on disabled <button>, which is why the previous native
                `title` attribute fired inconsistently. */}
            <span className="inline-flex">
              <Button
                size="icon"
                variant={grab.state !== 'idle' ? 'default' : 'ghost'}
                className={`h-8 w-8 ${grab.state !== 'idle' ? 'bg-foreground/80 text-background hover:bg-foreground/90' : ''}`}
                onClick={grab.toggle}
                disabled={isBlankTab}
              >
                <Crosshair className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {`Grab page element (${navigator.userAgent.includes('Mac') ? '⌘C' : 'Ctrl+C'})`}
          </TooltipContent>
        </Tooltip>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void window.api.browser.openDevTools({ browserPageId: browserTab.id })}
          title="Open browser devtools"
        >
          <SquareCode className="size-4" />
        </Button>

        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => {
            if (!externalUrl) {
              return
            }
            void window.api.shell.openUrl(externalUrl)
          }}
          title="Open in default browser"
          disabled={!externalUrl}
        >
          <ExternalLink className="size-4" />
        </Button>

        <BrowserToolbarMenu
          currentProfileId={sessionProfileId}
          workspaceId={workspaceId}
          browserPageId={browserTab.id}
          viewportPresetId={browserTab.viewportPresetId ?? null}
          onDestroyWebview={() => destroyPersistentWebview(browserTab.id)}
        />
      </div>
      {downloadState ? (
        <div className="flex items-center gap-3 border-b border-border/60 bg-amber-500/10 px-3 py-2 text-xs text-foreground/90">
          <div className="min-w-0 flex-1">
            <div className="truncate font-medium text-foreground">{downloadState.filename}</div>
            <div className="truncate text-muted-foreground">
              {downloadState.status === 'requested'
                ? `Download from ${downloadState.origin}`
                : `Downloading from ${downloadState.origin}${downloadProgressLabel ? ` • ${downloadProgressLabel}` : ''}`}
            </div>
          </div>
          {downloadState.status === 'requested' ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7"
                onClick={() => {
                  void window.api.browser.acceptDownload({
                    downloadId: downloadState.downloadId
                  })
                }}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7"
                onClick={() => {
                  void window.api.browser.cancelDownload({
                    downloadId: downloadState.downloadId
                  })
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <span className="shrink-0 text-muted-foreground">
              {downloadProgressLabel ?? 'Downloading'}
            </span>
          )}
        </div>
      ) : null}
      {resourceNotice ? (
        <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground">
          <span>{resourceNotice}</span>
          <button
            type="button"
            onClick={() => setResourceNotice(null)}
            className="shrink-0 text-muted-foreground/60 hover:text-foreground"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      ) : null}
      {grab.state !== 'idle' ? (
        <div
          className={cn(
            'flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs text-foreground/90',
            grab.state === 'error'
              ? 'bg-destructive/10'
              : grab.state === 'confirming'
                ? 'bg-green-500/10'
                : 'bg-blue-500/10'
          )}
        >
          <Crosshair
            className={cn(
              'size-3 shrink-0',
              grab.state === 'error'
                ? 'text-destructive'
                : grab.state === 'confirming'
                  ? 'text-green-500'
                  : 'text-blue-500'
            )}
          />
          <span>
            {grab.state === 'error'
              ? `Grab failed: ${grab.error ?? 'Unknown error'}`
              : grab.state === 'confirming'
                ? 'Copied — press S to screenshot, or select another element'
                : 'Click or hover an element, then press C to copy or S to screenshot.'}
          </span>
          <button
            className="ml-auto shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            onClick={grab.cancel}
          >
            Cancel
          </button>
        </div>
      ) : null}
      <div
        ref={containerRef}
        className="relative flex min-h-0 flex-1 overflow-hidden bg-background"
      >
        <BrowserFind isOpen={findOpen} onClose={() => setFindOpen(false)} webviewRef={webviewRef} />
        {showFailureOverlay ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02),transparent_58%)] px-6">
            <div className="flex max-w-sm flex-col items-center px-8 py-8 text-center opacity-70">
              <div className="mb-4 rounded-full border border-border/70 bg-muted/30 p-3">
                <Globe className="size-5 text-muted-foreground" />
              </div>
              <h2 className="text-base font-semibold text-foreground/85">
                {loadErrorMeta.host ? `Can't reach ${loadErrorMeta.host}` : "Can't load this page"}
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                {formatLoadFailureDescription(browserTab.loadError, loadErrorMeta)}
              </p>
              {loadErrorHint ? (
                <p className="mt-2 text-xs text-muted-foreground/80">{loadErrorHint}</p>
              ) : null}
              <div className="mt-5 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-9 gap-2 px-3"
                  title="Retry"
                  onClick={() => {
                    const webview = webviewRef.current
                    if (!webview) {
                      return
                    }
                    onUpdatePageStateRef.current(browserTab.id, {
                      loading: true
                    })
                    retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
                  }}
                >
                  <RefreshCw className="size-4" />
                  <span>Refresh</span>
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-9 gap-2 px-3"
                  title="Copy failed page URL"
                  onClick={() => {
                    // Why: failed guests often leave users stranded on a blank
                    // error surface. Put the current URL on the clipboard from
                    // the recovery UI itself so they can retry elsewhere
                    // without having to discover the toolbar overflow first.
                    void window.api.ui.writeClipboardText(currentBrowserUrl)
                    setResourceNotice('Copied the current page URL.')
                  }}
                >
                  <Copy className="size-4" />
                  <span>Copy Address</span>
                </Button>
                {externalUrl ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-9 gap-2 px-3"
                    title="Open failed page in default browser"
                    onClick={() => {
                      // Why: page failures inside Orca can still be recoverable
                      // in the system browser, especially for OAuth, captive
                      // portals, or enterprise auth flows that rely on a full
                      // browser profile. Keep this action in the failed-state
                      // overlay so recovery does not depend on toolbar affordance
                      // discovery while the guest itself is unusable.
                      void window.api.shell.openUrl(externalUrl)
                    }}
                  >
                    <ExternalLink className="size-4" />
                    <span>Open Externally</span>
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
        {isBlankTab ? (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02),transparent_58%)] px-6">
            <div className="flex flex-col items-center px-8 py-8 text-center opacity-70">
              <div className="mb-4 rounded-full border border-border/70 bg-muted/30 p-3">
                <Globe className="size-5 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-base font-semibold text-foreground/85">New Tab</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Type a URL above to start browsing.
                </p>
              </div>
            </div>
          </div>
        ) : null}
        {/* Right-click context dropdown: positioned at the element's center,
            shown when grab.contextMenu is true (user right-clicked). */}
        <DropdownMenu
          open={grab.state === 'confirming' && grab.contextMenu}
          onOpenChange={(open) => {
            if (!open && grab.state === 'confirming') {
              // Why: skip rearm if a menu action (Copy/Screenshot) already
              // handled the rearm — see grabMenuActionTakenRef.
              if (grabMenuActionTakenRef.current) {
                grabMenuActionTakenRef.current = false
                return
              }
              grab.rearm()
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <button
              aria-hidden
              tabIndex={-1}
              className="pointer-events-none absolute size-px opacity-0"
              style={(() => {
                if (!grab.payload) {
                  return { left: 0, top: 0 }
                }
                const rect = grab.payload.target.rectViewport
                const webview = webviewRef.current
                const webviewRect = webview?.getBoundingClientRect()
                const cRect = containerRef.current?.getBoundingClientRect()
                const offsetX = (webviewRect?.left ?? 0) - (cRect?.left ?? 0)
                const offsetY = (webviewRect?.top ?? 0) - (cRect?.top ?? 0)
                return {
                  left: offsetX + rect.x + rect.width / 2,
                  top: offsetY + rect.y + rect.height / 2
                }
              })()}
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={4}>
            <DropdownMenuItem onSelect={handleGrabCopy}>
              <Copy className="size-3.5" />
              Copy Contents
              <DropdownMenuShortcut>C</DropdownMenuShortcut>
            </DropdownMenuItem>
            {grab.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
              <DropdownMenuItem onSelect={handleGrabCopyScreenshot}>
                <Image className="size-3.5" />
                Copy Screenshot
                <DropdownMenuShortcut>S</DropdownMenuShortcut>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                grabMenuActionTakenRef.current = true
                grab.cancel()
              }}
            >
              Cancel
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Inline toast bubble (left-click auto-copy feedback). Positioned
            below (or above if near viewport bottom) so it doesn't occlude
            the element. The "···" button opens the same action dropdown as
            right-click for users who prefer clicking. */}
        {grabToast ? (
          <div
            className="absolute z-30 flex items-center animate-in fade-in zoom-in-95 duration-150"
            style={{
              left: grabToast.x,
              top: grabToast.y,
              transform: grabToast.below
                ? 'translate(-50%, 8px)'
                : 'translate(-50%, -100%) translateY(-8px)',
              flexDirection: grabToast.below ? 'column' : 'column-reverse'
            }}
          >
            {/* Caret pointing toward the element */}
            <div
              className="h-2 w-4 shrink-0"
              style={{
                clipPath: grabToast.below
                  ? 'polygon(50% 0%, 0% 100%, 100% 100%)'
                  : 'polygon(0% 0%, 100% 0%, 50% 100%)',
                background: 'white'
              }}
            />
            <div
              className={`flex items-center gap-1.5 rounded-full py-1.5 pl-3 pr-1.5 shadow-lg ${
                grabToast.type === 'success' ? 'bg-white text-gray-900' : 'bg-white text-red-600'
              }`}
            >
              {grabToast.type === 'success' ? (
                <CircleCheck className="size-4 fill-blue-600 text-white" />
              ) : (
                <OctagonX className="size-4 text-red-500" />
              )}
              <span className="text-sm font-semibold">{grabToast.message}</span>
              <DropdownMenu
                onOpenChange={(open) => {
                  if (open) {
                    clearTimeout(grabToastTimerRef.current)
                  } else {
                    grabToastTimerRef.current = setTimeout(() => dismissGrabToast(), 1200)
                  }
                }}
              >
                <DropdownMenuTrigger asChild>
                  <button className="flex size-6 items-center justify-center rounded-full text-gray-500 transition-colors hover:bg-black/10 hover:text-gray-700">
                    <span className="text-sm font-bold leading-none">···</span>
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" sideOffset={4}>
                  <DropdownMenuItem
                    onSelect={() => {
                      const dataUrl = grabToast.payload?.screenshot?.dataUrl
                      if (dataUrl?.startsWith('data:image/png;base64,')) {
                        void window.api.ui.writeClipboardImage(dataUrl)
                        setGrabToast((prev) =>
                          prev ? { ...prev, message: 'Screenshotted' } : null
                        )
                      }
                    }}
                    disabled={
                      !grabToast.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,')
                    }
                  >
                    <Image className="size-3.5" />
                    Copy Screenshot
                    <DropdownMenuShortcut>S</DropdownMenuShortcut>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
