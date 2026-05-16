/* eslint-disable max-lines */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
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
  MessageSquarePlus,
  OctagonX,
  RefreshCw,
  SquareCode,
  Trash2
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { ORCA_BROWSER_BLANK_URL, ORCA_BROWSER_PARTITION } from '../../../../shared/constants'
import type {
  BrowserLoadError,
  BrowserPage as BrowserPageState,
  BrowserWorkspace as BrowserWorkspaceState
} from '../../../../shared/types'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken
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
  registerPersistentWebview,
  registeredWebContentsIds,
  webviewRegistry
} from './webview-registry'
import type {
  BrowserDownloadRequestedEvent,
  BrowserDownloadProgressEvent,
  BrowserDownloadFinishedEvent
} from '../../../../shared/browser-guest-events'
import {
  GRAB_BUDGET,
  type BrowserAnnotationIntent,
  type BrowserAnnotationPayload,
  type BrowserAnnotationPriority,
  type BrowserGrabPayload,
  type BrowserGrabRect,
  type BrowserGrabScreenshot,
  type BrowserPageAnnotation
} from '../../../../shared/browser-grab-types'
import { BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX } from '../../../../shared/browser-annotation-viewport-bridge'
import { useGrabMode } from './useGrabMode'
import { formatGrabPayloadAsText } from './GrabConfirmationSheet'
import { formatBrowserAnnotationsAsMarkdown } from './browser-annotation-output'
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
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import type {
  BrowserBackResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserScreenshotResult,
  BrowserTabInfo
} from '../../../../shared/runtime-types'
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

type GrabIntent = 'copy' | 'annotate'

type BrowserOverlayAnchor = {
  x: number
  y: number
  below: boolean
}

type BrowserOverlayViewport = {
  scrollX: number
  scrollY: number
  version: number
}

const EMPTY_BROWSER_PAGES: BrowserPageState[] = []
const EMPTY_BROWSER_ANNOTATIONS: BrowserPageAnnotation[] = []
const PENDING_ANNOTATION_CARD_HEIGHT = 330

function createBrowserAnnotationId(): string {
  return `browser-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createBrowserAnnotationPayload(payload: BrowserGrabPayload): BrowserAnnotationPayload {
  return {
    ...payload,
    // Why: annotations are persisted renderer state; screenshot data is a
    // transient copy action payload and can be megabytes per selection.
    screenshot: null
  }
}

function getBrowserOverlayAnchor(
  payload: BrowserGrabPayload,
  container: HTMLElement | null,
  webview: Electron.WebviewTag | null,
  viewport: BrowserOverlayViewport
): BrowserOverlayAnchor {
  const containerRect = container?.getBoundingClientRect()
  const webviewRect = webview?.getBoundingClientRect()
  const rect = getLiveBrowserAnnotationRect(payload, viewport)
  const offsetX = (webviewRect?.left ?? 0) - (containerRect?.left ?? 0)
  const offsetY = (webviewRect?.top ?? 0) - (containerRect?.top ?? 0)
  const elementBottom = offsetY + rect.y + rect.height
  const elementTop = offsetY + rect.y
  const containerWidth = containerRect?.width ?? 0
  const containerHeight = containerRect?.height ?? 0
  const below = elementBottom + PENDING_ANNOTATION_CARD_HEIGHT < containerHeight
  return {
    x: clampNumber(offsetX + rect.x + rect.width / 2, 12, Math.max(12, containerWidth - 12)),
    y: clampNumber(below ? elementBottom : elementTop, 12, Math.max(12, containerHeight - 12)),
    below
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getLiveBrowserAnnotationRect(
  payload: BrowserGrabPayload,
  viewport: BrowserOverlayViewport
): BrowserGrabRect {
  if (payload.target.isFixed) {
    return payload.target.rectViewport
  }
  const scrollX = viewport.version === 0 ? payload.page.scrollX : viewport.scrollX
  const scrollY = viewport.version === 0 ? payload.page.scrollY : viewport.scrollY
  return {
    ...payload.target.rectViewport,
    x: payload.target.rectPage.x - scrollX,
    y: payload.target.rectPage.y - scrollY
  }
}

function PendingBrowserAnnotationCard({
  payload,
  anchor,
  portalContainer,
  onAdd,
  onCancel
}: {
  payload: BrowserGrabPayload
  anchor: BrowserOverlayAnchor
  portalContainer: HTMLElement | null
  onAdd: (
    comment: string,
    intent: BrowserAnnotationIntent,
    priority: BrowserAnnotationPriority
  ) => void
  onCancel: () => void
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const [intent, setIntent] = useState<BrowserAnnotationIntent>('change')
  const [priority, setPriority] = useState<BrowserAnnotationPriority>('important')
  const trimmed = comment.trim()

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) {
          onCancel()
        }
      }}
    >
      <PopoverAnchor asChild>
        <span
          className="pointer-events-none absolute size-px"
          style={{ left: anchor.x, top: anchor.y }}
        />
      </PopoverAnchor>
      <PopoverContent
        side={anchor.below ? 'bottom' : 'top'}
        align="center"
        sideOffset={10}
        collisionBoundary={portalContainer ?? undefined}
        collisionPadding={12}
        portalContainer={portalContainer}
        className="z-40 w-[22rem] max-w-[calc(var(--radix-popover-content-available-width)-1rem)] p-3 shadow-[0_10px_24px_rgba(0,0,0,0.18)]"
        aria-label="Add browser annotation"
        onEscapeKeyDown={(event) => {
          event.preventDefault()
          onCancel()
        }}
      >
        <div className="mb-2 min-w-0">
          <div className="truncate text-xs font-medium text-foreground">
            {payload.target.accessibility.accessibleName ||
              payload.target.textSnippet ||
              payload.target.tagName}
          </div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {payload.target.selector}
          </div>
        </div>
        <Label htmlFor="browser-annotation-comment" className="sr-only">
          Annotation comment
        </Label>
        <textarea
          id="browser-annotation-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder="Describe what the agent should change here..."
          maxLength={GRAB_BUDGET.annotationCommentMaxLength}
          className="h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
            }
          }}
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="min-w-0">
            <Label className="mb-1 block text-xs text-muted-foreground">Intent</Label>
            <Select
              value={intent}
              onValueChange={(value) => setIntent(value as BrowserAnnotationIntent)}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-full text-xs"
                aria-label="Annotation intent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                portalContainer={portalContainer}
                collisionBoundary={portalContainer ?? undefined}
              >
                <SelectItem value="change">Change</SelectItem>
                <SelectItem value="fix">Fix</SelectItem>
                <SelectItem value="question">Question</SelectItem>
                <SelectItem value="approve">Approve</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0">
            <Label className="mb-1 block text-xs text-muted-foreground">Priority</Label>
            <Select
              value={priority}
              onValueChange={(value) => setPriority(value as BrowserAnnotationPriority)}
            >
              <SelectTrigger
                size="sm"
                className="h-8 w-full text-xs"
                aria-label="Annotation priority"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent
                position="popper"
                portalContainer={portalContainer}
                collisionBoundary={portalContainer ?? undefined}
              >
                <SelectItem value="important">Important</SelectItem>
                <SelectItem value="blocking">Blocking</SelectItem>
                <SelectItem value="suggestion">Suggestion</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={!trimmed}
            onClick={() => onAdd(trimmed, intent, priority)}
          >
            <MessageSquarePlus className="size-3.5" />
            Add
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function buildLoadError(event: {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
}): BrowserLoadError {
  return {
    code: event.errorCode ?? -1,
    description: event.errorDescription ?? 'Unknown load failure',
    validatedUrl: redactKagiSessionToken(event.validatedURL ?? 'about:blank')
  }
}

function toDisplayUrl(url: string): string {
  return url === ORCA_BROWSER_BLANK_URL ? 'about:blank' : redactKagiSessionToken(url)
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

function fileUrlToAbsolutePath(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'file:') {
      return null
    }
    const hostPrefix =
      parsed.hostname && parsed.hostname !== 'localhost' ? `//${parsed.hostname}` : ''
    let absolutePath = `${hostPrefix}${decodeURIComponent(parsed.pathname)}`
    if (/^\/[A-Za-z]:\//.test(absolutePath)) {
      absolutePath = absolutePath.slice(1)
    }
    return absolutePath
  } catch {
    return null
  }
}

function getNotebookPathFromBrowserUrl(url: string): string | null {
  const filePath = fileUrlToAbsolutePath(url)
  return filePath?.toLowerCase().endsWith('.ipynb') ? filePath : null
}

function getRemoteBrowserKeypressKey(event: React.KeyboardEvent): string | null {
  if (event.key.length === 1) {
    return null
  }
  if (event.metaKey || event.ctrlKey || event.altKey) {
    return null
  }
  const supported = new Set([
    'Enter',
    'Backspace',
    'Delete',
    'Tab',
    'Escape',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown'
  ])
  return supported.has(event.key) ? event.key : null
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
  return normalizeExternalBrowserUrl(redactKagiSessionToken(currentUrl))
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
  const activeRuntimeEnvironmentId = useAppStore(
    (s) => s.settings?.activeRuntimeEnvironmentId ?? null
  )
  const browserPagesByWorkspace = useAppStore((s) => s.browserPagesByWorkspace)
  const browserPages = browserPagesByWorkspace[browserTab.id] ?? EMPTY_BROWSER_PAGES
  const activeBrowserPage =
    browserPages.find((page) => page.id === browserTab.activePageId) ?? browserPages[0] ?? null
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const runtimeEnvironmentActive = Boolean(activeRuntimeEnvironmentId?.trim())

  useEffect(() => {
    if (!runtimeEnvironmentActive) {
      return
    }
    for (const page of browserPages) {
      destroyPersistentWebview(page.id)
    }
  }, [browserPages, runtimeEnvironmentActive])

  if (runtimeEnvironmentActive) {
    return activeBrowserPage ? (
      <RemoteBrowserPagePane
        browserTab={activeBrowserPage}
        worktreeId={browserTab.worktreeId}
        isActive={isActive}
        onUpdatePageState={updateBrowserPageState}
        onSetUrl={setBrowserPageUrl}
      />
    ) : (
      <div className="flex h-full min-h-0 flex-1 bg-background" />
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      {activeBrowserPage ? (
        <div className="relative flex min-h-0 flex-1">
          <BrowserPagePane
            key={activeBrowserPage.id}
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

function RemoteBrowserPagePane({
  browserTab,
  worktreeId,
  isActive,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  worktreeId: string
  isActive: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: (tabId: string, url: string) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const [addressBarValue, setAddressBarValue] = useState(toDisplayUrl(browserTab.url))
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const remotePageIdRef = useRef<string | null>(null)
  const activeRuntimeEnvironmentId = settings?.activeRuntimeEnvironmentId?.trim() ?? null
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)

  useEffect(() => {
    if (document.activeElement === addressBarInputRef.current) {
      return
    }
    setAddressBarValue(toDisplayUrl(browserTab.url))
  }, [browserTab.url])

  const runtimeTarget = useCallback(() => {
    const target = getActiveRuntimeTarget(settings)
    return target.kind === 'environment' ? target : null
  }, [settings])

  useEffect(() => {
    if (!activeRuntimeEnvironmentId) {
      return
    }
    return () => {
      const remotePageId = remotePageIdRef.current
      if (!remotePageId) {
        return
      }
      const state = useAppStore.getState()
      const currentEnvironmentId = state.settings?.activeRuntimeEnvironmentId?.trim() ?? null
      const pageStillExists = Object.values(state.browserPagesByWorkspace).some((pages) =>
        pages.some((page) => page.id === browserTab.id)
      )
      if (currentEnvironmentId === activeRuntimeEnvironmentId && pageStillExists) {
        return
      }
      const removedHandle = state.removeRemoteBrowserPageHandle(browserTab.id, remotePageId)
      remotePageIdRef.current = null
      if (!removedHandle) {
        return
      }
      // Why: remote browser tabs outlive React components on the daemon. Close
      // only when the local page is gone or its owning runtime environment is.
      void callRuntimeRpc(
        { kind: 'environment', environmentId: removedHandle.environmentId },
        'browser.tabClose',
        { worktree: `id:${worktreeId}`, page: removedHandle.remotePageId },
        { timeoutMs: 15_000 }
      ).catch(() => {})
    }
  }, [activeRuntimeEnvironmentId, browserTab.id, worktreeId])

  const applyRemoteTabInfo = useCallback(
    (tab: Pick<BrowserTabInfo, 'url' | 'title'>): void => {
      const safeUrl = redactKagiSessionToken(tab.url || 'about:blank')
      onSetUrl(browserTab.id, safeUrl)
      onUpdatePageState(browserTab.id, {
        title: getBrowserDisplayTitle(tab.title, safeUrl),
        loading: false,
        loadError: null
      })
      setAddressBarValue(toDisplayUrl(safeUrl))
    },
    [browserTab.id, onSetUrl, onUpdatePageState]
  )

  const captureRemoteScreenshot = useCallback(
    async (pageId: string): Promise<void> => {
      const target = runtimeTarget()
      if (!target) {
        return
      }
      const screenshot = await callRuntimeRpc<BrowserScreenshotResult>(
        target,
        'browser.screenshot',
        { worktree: `id:${worktreeId}`, page: pageId, format: 'png' },
        { timeoutMs: 30_000 }
      )
      setScreenshotUrl(`data:image/${screenshot.format};base64,${screenshot.data}`)
    },
    [runtimeTarget, worktreeId]
  )

  const ensureRemotePage = useCallback(async (): Promise<string | null> => {
    const target = runtimeTarget()
    if (!target) {
      return null
    }
    const existingHandle = useAppStore.getState().remoteBrowserPageHandlesByPageId[browserTab.id]
    if (existingHandle?.environmentId === target.environmentId) {
      remotePageIdRef.current = existingHandle.remotePageId
      return existingHandle.remotePageId
    }
    const initialUrl =
      browserTab.url === ORCA_BROWSER_BLANK_URL ? 'about:blank' : browserTab.url || 'about:blank'
    const created = await callRuntimeRpc<{ browserPageId: string }>(
      target,
      'browser.tabCreate',
      { worktree: `id:${worktreeId}`, url: initialUrl },
      { timeoutMs: 30_000 }
    )
    remotePageIdRef.current = created.browserPageId
    setRemoteBrowserPageHandle(browserTab.id, {
      environmentId: target.environmentId,
      remotePageId: created.browserPageId
    })
    return created.browserPageId
  }, [browserTab.id, browserTab.url, runtimeTarget, setRemoteBrowserPageHandle, worktreeId])

  const refreshRemoteView = useCallback(
    async (pageId?: string): Promise<void> => {
      const target = runtimeTarget()
      const targetPageId = pageId ?? remotePageIdRef.current
      if (!target || !targetPageId) {
        return
      }
      const shown = await callRuntimeRpc<{ tab: BrowserTabInfo }>(
        target,
        'browser.tabShow',
        { worktree: `id:${worktreeId}`, page: targetPageId },
        { timeoutMs: 15_000 }
      )
      applyRemoteTabInfo(shown.tab)
      await captureRemoteScreenshot(targetPageId)
    },
    [applyRemoteTabInfo, captureRemoteScreenshot, runtimeTarget, worktreeId]
  )

  useEffect(() => {
    if (!isActive) {
      return
    }
    let cancelled = false
    setBusy(true)
    setRemoteError(null)
    void ensureRemotePage()
      .then(async (pageId) => {
        if (!pageId || cancelled) {
          return
        }
        await refreshRemoteView(pageId)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setRemoteError(error instanceof Error ? error.message : 'Failed to open remote browser.')
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [ensureRemotePage, isActive, refreshRemoteView])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(() => {
      addressBarInputRef.current?.focus()
      addressBarInputRef.current?.select()
    })
  }, [isActive])

  const runRemoteNavigation = useCallback(
    async (
      method: 'browser.goto' | 'browser.back' | 'browser.forward' | 'browser.reload',
      url?: string
    ) => {
      const target = runtimeTarget()
      if (!target) {
        return
      }
      const pageId = await ensureRemotePage()
      if (!pageId) {
        return
      }
      setBusy(true)
      setRemoteError(null)
      onUpdatePageState(browserTab.id, { loading: true, loadError: null })
      try {
        const params =
          method === 'browser.goto'
            ? { worktree: `id:${worktreeId}`, page: pageId, url: url ?? 'about:blank' }
            : { worktree: `id:${worktreeId}`, page: pageId }
        const result = await callRuntimeRpc<
          BrowserGotoResult | BrowserBackResult | BrowserReloadResult
        >(target, method, params, { timeoutMs: 30_000 })
        applyRemoteTabInfo(result)
        await captureRemoteScreenshot(pageId)
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Remote browser command failed.'
        setRemoteError(message)
        onUpdatePageState(browserTab.id, {
          loading: false,
          loadError: { code: 0, description: message, validatedUrl: url ?? browserTab.url }
        })
      } finally {
        setBusy(false)
      }
    },
    [
      applyRemoteTabInfo,
      browserTab.id,
      browserTab.url,
      captureRemoteScreenshot,
      ensureRemotePage,
      onUpdatePageState,
      runtimeTarget,
      worktreeId
    ]
  )

  const navigateToUrl = useCallback(
    (url: string): void => {
      void runRemoteNavigation('browser.goto', url)
    },
    [runRemoteNavigation]
  )

  const submitAddressBar = (): void => {
    const searchEngine = useAppStore.getState().browserDefaultSearchEngine
    const kagiSessionLink = useAppStore.getState().browserKagiSessionLink
    const nextUrl = normalizeBrowserNavigationUrl(addressBarValue, searchEngine, {
      kagiSessionLink
    })
    if (!nextUrl) {
      const message = 'Enter a valid http(s) or localhost URL.'
      setRemoteError(message)
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

  const clickRemoteScreenshot = (event: React.MouseEvent<HTMLImageElement>): void => {
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    const image = imageRef.current
    if (!target || !pageId || !image) {
      return
    }
    const rect = image.getBoundingClientRect()
    image.focus()
    const scaleX = image.naturalWidth / rect.width
    const scaleY = image.naturalHeight / rect.height
    const x = Math.round((event.clientX - rect.left) * scaleX)
    const y = Math.round((event.clientY - rect.top) * scaleY)
    setBusy(true)
    setRemoteError(null)
    void (async () => {
      try {
        const params = { worktree: `id:${worktreeId}`, page: pageId }
        await callRuntimeRpc(
          target,
          'browser.mouseMove',
          { ...params, x, y },
          { timeoutMs: 15_000 }
        )
        await callRuntimeRpc(target, 'browser.mouseDown', params, { timeoutMs: 15_000 })
        await callRuntimeRpc(target, 'browser.mouseUp', params, { timeoutMs: 15_000 })
        await new Promise((resolve) => window.setTimeout(resolve, 300))
        await refreshRemoteView(pageId)
      } catch (error) {
        setRemoteError(error instanceof Error ? error.message : 'Remote click failed.')
      } finally {
        setBusy(false)
      }
    })()
  }

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    if (isEditableKeyboardTarget(event.target)) {
      return
    }
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    if (!target || !pageId) {
      return
    }
    const params = { worktree: `id:${worktreeId}`, page: pageId }
    const text =
      event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey ? event.key : null
    const key = text ? null : getRemoteBrowserKeypressKey(event)
    if (!text && !key) {
      return
    }
    event.preventDefault()
    setRemoteError(null)
    void (async () => {
      try {
        if (text) {
          await callRuntimeRpc(
            target,
            'browser.keyboardInsertText',
            { ...params, text },
            { timeoutMs: 15_000 }
          )
        } else if (key) {
          await callRuntimeRpc(
            target,
            'browser.keypress',
            { ...params, key },
            { timeoutMs: 15_000 }
          )
        }
        await new Promise((resolve) => window.setTimeout(resolve, 100))
        await refreshRemoteView(pageId)
      } catch (error) {
        setRemoteError(error instanceof Error ? error.message : 'Remote keyboard input failed.')
      }
    })()
  }

  const handleRemoteScreenshotWheel = (event: React.WheelEvent<HTMLImageElement>): void => {
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    if (!target || !pageId) {
      return
    }
    event.preventDefault()
    setRemoteError(null)
    void callRuntimeRpc(
      target,
      'browser.mouseWheel',
      {
        worktree: `id:${worktreeId}`,
        page: pageId,
        dx: Math.round(event.deltaX),
        dy: Math.round(event.deltaY)
      },
      { timeoutMs: 15_000 }
    )
      .then(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 100))
        await refreshRemoteView(pageId)
      })
      .catch((error: unknown) => {
        setRemoteError(error instanceof Error ? error.message : 'Remote scroll failed.')
      })
  }

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background">
      <div className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void runRemoteNavigation('browser.back')}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void runRemoteNavigation('browser.forward')}
        >
          <ArrowRight className="size-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => void runRemoteNavigation('browser.reload')}
        >
          {busy || browserTab.loading ? (
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
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 opacity-50"
              aria-disabled="true"
              aria-label="Browser annotations unavailable in remote runtime"
              onClick={(event) => {
                event.preventDefault()
              }}
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Browser annotations are only available in local browser tabs.
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-auto bg-muted/20">
        {screenshotUrl ? (
          <img
            ref={imageRef}
            src={screenshotUrl}
            alt=""
            tabIndex={0}
            className="max-h-full max-w-full cursor-crosshair bg-white object-contain"
            onClick={clickRemoteScreenshot}
            onKeyDown={handleRemoteScreenshotKeyDown}
            onWheel={handleRemoteScreenshotWheel}
            draggable={false}
          />
        ) : (
          <div className="flex max-w-sm flex-col items-center gap-2 px-6 text-center">
            {busy ? (
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            ) : (
              <Globe className="size-5 text-muted-foreground" />
            )}
            <div className="text-sm font-medium text-foreground">
              {busy ? 'Opening remote browser' : 'Remote browser'}
            </div>
            <div className="text-xs leading-5 text-muted-foreground">
              This pane is rendered from the active runtime server.
            </div>
          </div>
        )}
        {remoteError ? (
          <div className="absolute bottom-4 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            {remoteError}
          </div>
        ) : null}
      </div>
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
  const [grabIntent, setGrabIntent] = useState<GrabIntent>('copy')
  const grabIntentRef = useRef(grabIntent)
  grabIntentRef.current = grabIntent
  const [pendingAnnotationPayload, setPendingAnnotationPayload] =
    useState<BrowserGrabPayload | null>(null)
  const pendingAnnotationPayloadRef = useRef<BrowserGrabPayload | null>(null)
  pendingAnnotationPayloadRef.current = pendingAnnotationPayload
  const [browserOverlayViewport, setBrowserOverlayViewport] = useState<BrowserOverlayViewport>({
    scrollX: 0,
    scrollY: 0,
    version: 0
  })
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const annotationViewportBridgeTokenRef = useRef(
    typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replaceAll('-', '')
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  )
  const browserAnnotations = useAppStore(
    (s) => s.browserAnnotationsByPageId[browserTab.id] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const browserAnnotationsRef = useRef(browserAnnotations)
  browserAnnotationsRef.current = browserAnnotations
  const [browserAnnotationTrayOpen, setBrowserAnnotationTrayOpen] = useState(true)
  const [browserAnnotationsCopied, setBrowserAnnotationsCopied] = useState(false)
  const addBrowserPageAnnotation = useAppStore((s) => s.addBrowserPageAnnotation)
  const deleteBrowserPageAnnotation = useAppStore((s) => s.deleteBrowserPageAnnotation)
  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const clearBrowserPageAnnotationsRef = useRef(clearBrowserPageAnnotations)
  clearBrowserPageAnnotationsRef.current = clearBrowserPageAnnotations
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
  const annotationCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  // Why: clear the toast auto-dismiss timer on unmount so it cannot fire
  // after the component is destroyed (prevents setState-on-unmounted warnings
  // and stale rearm calls).
  useEffect(() => {
    return () => {
      clearTimeout(grabToastTimerRef.current)
      clearTimeout(annotationCopyTimerRef.current)
    }
  }, [])

  const grabRef = useRef(grab)
  grabRef.current = grab

  useEffect(() => {
    setPendingAnnotationPayload(null)
    setBrowserOverlayViewport({ scrollX: 0, scrollY: 0, version: 0 })
    setBrowserAnnotationTrayOpen(true)
    setBrowserAnnotationsCopied(false)
    clearTimeout(annotationCopyTimerRef.current)
    if (grabRef.current.state !== 'idle' && grabRef.current.state !== 'error') {
      grabRef.current.cancel()
    }
  }, [browserTab.id])

  const dismissGrabToast = useCallback(() => {
    clearTimeout(grabToastTimerRef.current)
    setGrabToast(null)
    // Why: only rearm if the grab state is still 'confirming', meaning the
    // auto-copy toast is dismissing naturally. If the user already triggered
    // a shortcut (C/S) that called rearm, the state will be 'armed' and we
    // skip to avoid a double-rearm race.
    if (
      grabRef.current.state === 'confirming' &&
      !(grabIntentRef.current === 'annotate' && pendingAnnotationPayloadRef.current)
    ) {
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

  // Why: the same in-guest picker powers two flows. Cmd/Ctrl+C preserves the
  // original one-click copy behavior, while the toolbar annotation action turns
  // the selected element into a pending feedback note.
  useEffect(() => {
    if (grab.state !== 'confirming' || !grab.payload) {
      return
    }
    if (grabIntent === 'annotate') {
      setPendingAnnotationPayload(grab.payload)
      return
    }
    if (!grab.contextMenu) {
      const text = formatGrabPayloadAsText(grab.payload)
      void window.api.ui.writeClipboardText(text)
      showGrabToast('Copied', 'success', grab.payload)
    }
  }, [grab.state, grab.payload, grab.contextMenu, grabIntent, showGrabToast])

  useEffect(() => {
    if (grab.state === 'idle' || grab.state === 'error') {
      setPendingAnnotationPayload(null)
    }
  }, [grab.state])

  useEffect(() => {
    if (browserAnnotations.length === 0) {
      setBrowserAnnotationTrayOpen(true)
      setBrowserAnnotationsCopied(false)
      clearTimeout(annotationCopyTimerRef.current)
    }
  }, [browserAnnotations.length])

  useEffect(() => {
    if (!isActive || (!pendingAnnotationPayload && browserAnnotations.length === 0)) {
      return
    }

    const observedContainer = containerRef.current
    const resizeObserver =
      typeof ResizeObserver === 'undefined' || !observedContainer
        ? null
        : new ResizeObserver(() => {
            setBrowserOverlayViewport((current) => ({ ...current, version: current.version + 1 }))
          })
    if (resizeObserver && observedContainer) {
      resizeObserver.observe(observedContainer)
    }

    return () => {
      resizeObserver?.disconnect()
    }
  }, [browserAnnotations.length, isActive, pendingAnnotationPayload])

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

  const syncBrowserAnnotationViewportBridge = useCallback((): void => {
    const pendingAnnotationPayload = pendingAnnotationPayloadRef.current
    // Why: existing annotation badges are rendered in the guest process for
    // compositor-smooth scroll; only the pending dialog needs viewport messages.
    const markers = browserAnnotationsRef.current.map((annotation, index) => ({
      id: annotation.id,
      index,
      isFixed: annotation.payload.target.isFixed === true,
      rectPage: annotation.payload.target.rectPage,
      rectViewport: annotation.payload.target.rectViewport
    }))
    const enabled = isActiveRef.current && (pendingAnnotationPayload !== null || markers.length > 0)
    void window.api.browser
      .setAnnotationViewportBridge({
        browserPageId: browserTab.id,
        emitViewport: pendingAnnotationPayload !== null,
        enabled,
        markers,
        token: annotationViewportBridgeTokenRef.current
      })
      .catch(() => {
        // The viewport bridge is visual-only; stale markers are less bad than
        // breaking the browser pane on a navigated or destroyed guest.
      })
  }, [browserTab.id])

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
      registerPersistentWebview(browserTab.id, webview)
      container.appendChild(webview)
      needsInitialNavigation = true
    }

    webviewRef.current = webview

    const handleDomReady = (): void => {
      const webContentsId = webview.getWebContentsId()
      let queuedAnnotationViewportBridgeSync = false
      if (registeredWebContentsIds.get(browserTab.id) !== webContentsId) {
        registeredWebContentsIds.set(browserTab.id, webContentsId)
        queuedAnnotationViewportBridgeSync = true
        void window.api.browser
          .registerGuest({
            browserPageId: browserTab.id,
            workspaceId,
            worktreeId,
            sessionProfileId,
            webContentsId
          })
          .finally(() => syncBrowserAnnotationViewportBridge())
      }
      syncNavigationState(webview)
      if (keepAddressBarFocusRef.current) {
        focusAddressBarNow()
      }
      if (!queuedAnnotationViewportBridgeSync) {
        syncBrowserAnnotationViewportBridge()
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
      // Why: reloads replace the document without changing URL, invalidating
      // captured element rects and DOM context just like navigation does.
      clearBrowserPageAnnotationsRef.current(browserTab.id)
      setPendingAnnotationPayload(null)
      setBrowserOverlayViewport({ scrollX: 0, scrollY: 0, version: 0 })
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
      const browserModelUrl = redactKagiSessionToken(currentUrl)
      const activeLoadFailure = activeLoadFailureRef.current
      if (isChromiumErrorPage(currentUrl)) {
        trackNextLoadingEventRef.current = false
        const synthesizedFailure = {
          code: -1,
          description: 'This site could not be reached.',
          validatedUrl: redactKagiSessionToken(
            browserTabUrlRef.current || addressBarValueRef.current || 'about:blank'
          )
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
        const normalizedCurrentUrl =
          normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
        if (normalizedAttemptedUrl === normalizedCurrentUrl) {
          trackNextLoadingEventRef.current = false
          // Why: some webview failures still emit did-stop-loading on the
          // original destination URL. If we clear loadError here, the failed
          // navigation falls back to a blank Chromium surface even though Orca
          // already knows this exact load failed.
          onUpdatePageStateRef.current(browserTab.id, {
            loading: false,
            title: getBrowserDisplayTitle(webview.getTitle(), browserModelUrl),
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
      lastKnownWebviewUrlRef.current =
        normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
      rememberLiveBrowserUrl(browserTab.id, browserModelUrl)
      // Why: don't overwrite in-progress typing. See comment on the
      // browserTab.url sync effect above.
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(toDisplayUrl(browserModelUrl))
      }
      onSetUrlRef.current(browserTab.id, browserModelUrl)
      if (keepAddressBarFocusRef.current && currentUrl === ORCA_BROWSER_BLANK_URL) {
        focusAddressBarNow()
      } else {
        keepAddressBarFocusRef.current = false
      }
      onUpdatePageStateRef.current(browserTab.id, {
        loading: false,
        title: getBrowserDisplayTitle(webview.getTitle(), browserModelUrl),
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
      const browserModelUrl = redactKagiSessionToken(currentUrl)
      lastKnownWebviewUrlRef.current =
        normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
      rememberLiveBrowserUrl(browserTab.id, browserModelUrl)
      // Why: don't overwrite in-progress typing (see above).
      if (document.activeElement !== addressBarInputRef.current) {
        setAddressBarValue(toDisplayUrl(browserModelUrl))
      }
      onSetUrlRef.current(browserTab.id, browserModelUrl)
      onUpdatePageStateRef.current(browserTab.id, {
        title: webview.getTitle() || browserModelUrl,
        canGoBack: webview.canGoBack(),
        canGoForward: webview.canGoForward()
      })
    }

    const handleTitleUpdate = (event: { title?: string }): void => {
      try {
        const currentUrl = webview.getURL() || browserTab.url
        const browserModelUrl = redactKagiSessionToken(currentUrl)
        const title = getBrowserDisplayTitle(event.title, browserModelUrl)
        onUpdatePageStateRef.current(browserTab.id, { title })
        addBrowserHistoryEntryRef.current(browserModelUrl, title)
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

    const handleAnnotationViewportMessage = (event: { message?: string }): void => {
      const message = typeof event.message === 'string' ? event.message : ''
      const prefix = `${BROWSER_ANNOTATION_VIEWPORT_MESSAGE_PREFIX}${annotationViewportBridgeTokenRef.current}:`
      if (!message.startsWith(prefix)) {
        return
      }
      try {
        const next = JSON.parse(message.slice(prefix.length)) as {
          scrollX?: unknown
          scrollY?: unknown
        }
        const scrollX =
          typeof next.scrollX === 'number' && Number.isFinite(next.scrollX) ? next.scrollX : 0
        const scrollY =
          typeof next.scrollY === 'number' && Number.isFinite(next.scrollY) ? next.scrollY : 0
        setBrowserOverlayViewport((current) => {
          if (current.scrollX === scrollX && current.scrollY === scrollY) {
            return current.version === 0 ? { ...current, version: 1 } : current
          }
          return { scrollX, scrollY, version: current.version + 1 }
        })
      } catch {
        // Ignore unrelated or malformed guest console output.
      }
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
    webview.addEventListener('console-message', handleAnnotationViewportMessage)

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
      webview.removeEventListener('console-message', handleAnnotationViewportMessage)

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
    syncNavigationState,
    syncBrowserAnnotationViewportBridge
  ])

  useEffect(() => {
    syncBrowserAnnotationViewportBridge()
  }, [
    browserAnnotations.length,
    browserTab.id,
    isActive,
    pendingAnnotationPayload,
    syncBrowserAnnotationViewportBridge
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
            validatedUrl: redactKagiSessionToken(attemptedUrl)
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

  const startGrabIntent = useCallback(
    (nextIntent: GrabIntent): void => {
      setGrabIntent(nextIntent)
      if (nextIntent === 'copy') {
        setPendingAnnotationPayload(null)
      } else {
        setBrowserAnnotationTrayOpen(true)
      }
      if (grab.state === 'idle' || grab.state === 'error' || grabIntent === nextIntent) {
        grab.toggle()
      }
    },
    [grab, grabIntent]
  )

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
        startGrabIntent('copy')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, startGrabIntent])

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
        startGrabIntent('copy')
      }
    })
  }, [browserTab.id, startGrabIntent])

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
      if (grabIntent === 'annotate') {
        return
      }
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
    [grab, grabIntent, showGrabToast]
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

  const handleAddBrowserAnnotation = useCallback(
    (
      comment: string,
      intent: BrowserAnnotationIntent,
      priority: BrowserAnnotationPriority
    ): void => {
      const payload = pendingAnnotationPayload
      if (!payload) {
        return
      }
      addBrowserPageAnnotation({
        id: createBrowserAnnotationId(),
        browserPageId: browserTab.id,
        comment,
        intent,
        priority,
        createdAt: new Date().toISOString(),
        payload: createBrowserAnnotationPayload(payload)
      })
      setPendingAnnotationPayload(null)
      setBrowserAnnotationTrayOpen(true)
      showGrabToast('Annotation added', 'success', payload)
      grab.rearm()
    },
    [addBrowserPageAnnotation, browserTab.id, grab, pendingAnnotationPayload, showGrabToast]
  )

  const handleCancelPendingBrowserAnnotation = useCallback((): void => {
    setPendingAnnotationPayload(null)
    if (grabIntent === 'annotate' && grab.state === 'confirming') {
      grab.rearm()
    }
  }, [grab, grabIntent])

  const handleCopyBrowserAnnotations = useCallback((): void => {
    const markdown = formatBrowserAnnotationsAsMarkdown(browserAnnotations)
    if (!markdown) {
      return
    }
    void window.api.ui.writeClipboardText(markdown)
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(true)
    annotationCopyTimerRef.current = setTimeout(() => setBrowserAnnotationsCopied(false), 1400)
  }, [browserAnnotations])

  const handleClearBrowserAnnotations = useCallback((): void => {
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(false)
    clearBrowserPageAnnotations(browserTab.id)
  }, [browserTab.id, clearBrowserPageAnnotations])

  const navigateToUrl = useCallback(
    (url: string): void => {
      const navigateBrowserUrl = (targetUrl: string): void => {
        const browserModelUrl = redactKagiSessionToken(targetUrl)
        setAddressBarValue(toDisplayUrl(browserModelUrl))
        onSetUrlRef.current(browserTab.id, browserModelUrl)
        onUpdatePageStateRef.current(browserTab.id, {
          loading: true,
          loadError: null,
          title: getBrowserDisplayTitle(browserModelUrl, browserModelUrl)
        })
        setResourceNotice(null)

        const webview = webviewRef.current
        if (!webview) {
          return
        }
        trackNextLoadingEventRef.current = targetUrl !== ORCA_BROWSER_BLANK_URL
        lastKnownWebviewUrlRef.current =
          normalizeBrowserNavigationUrl(browserModelUrl) ?? browserModelUrl
        webview.src = targetUrl
        if (targetUrl !== ORCA_BROWSER_BLANK_URL) {
          focusWebviewNow()
        }
      }

      const notebookPath = getNotebookPathFromBrowserUrl(url)
      if (notebookPath) {
        void (async () => {
          const store = useAppStore.getState()
          const connectionId = getConnectionId(worktreeId)
          if (connectionId !== null) {
            navigateBrowserUrl(url)
            return
          }

          try {
            const activeWorktree = store.allWorktrees().find((w) => w.id === worktreeId)
            const fileContext: RuntimeFileOperationArgs = {
              settings: store.settings,
              worktreeId,
              worktreePath: activeWorktree?.path,
              connectionId: undefined
            }
            if (!isRemoteRuntimeFileOperation(fileContext, notebookPath)) {
              await window.api.fs.authorizeExternalPath({ targetPath: notebookPath })
            }
            const stat = await statRuntimePath(fileContext, notebookPath)
            if (stat.isDirectory) {
              navigateBrowserUrl(url)
              return
            }

            let relativePath = notebookPath
            if (activeWorktree?.path && isPathInsideWorktree(notebookPath, activeWorktree.path)) {
              relativePath =
                toWorktreeRelativePath(notebookPath, activeWorktree.path) ?? notebookPath
            }

            // Why: file:// notebooks in the browser are otherwise rendered as raw JSON by Chromium.
            store.setActiveTabType('editor')
            store.openFile(
              {
                filePath: notebookPath,
                relativePath,
                worktreeId,
                language: detectLanguage(notebookPath),
                mode: 'edit'
              },
              { preview: false, targetGroupId: store.ensureWorktreeRootGroup(worktreeId) }
            )
          } catch {
            navigateBrowserUrl(url)
          }
        })()
        return
      }

      navigateBrowserUrl(url)
    },
    [browserTab.id, focusWebviewNow, worktreeId]
  )

  const submitAddressBar = (): void => {
    keepAddressBarFocusRef.current = false
    const searchEngine = useAppStore.getState().browserDefaultSearchEngine
    const kagiSessionLink = useAppStore.getState().browserKagiSessionLink
    const nextUrl = normalizeBrowserNavigationUrl(addressBarValue, searchEngine, {
      kagiSessionLink
    })
    if (!nextUrl) {
      onUpdatePageStateRef.current(browserTab.id, {
        loadError: {
          code: 0,
          description: 'Enter a valid http(s) or localhost URL.',
          // Why: the user may have pasted a Kagi URL with a token; redact
          // before persisting it into BrowserPage.loadError.
          validatedUrl: redactKagiSessionToken(addressBarValue.trim()) || 'about:blank'
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
            <span className="inline-flex">
              <Button
                size="icon"
                variant={grab.state !== 'idle' && grabIntent === 'copy' ? 'default' : 'ghost'}
                className={cn(
                  'h-8 w-8',
                  grab.state !== 'idle' &&
                    grabIntent === 'copy' &&
                    'bg-foreground/80 text-background hover:bg-foreground/90'
                )}
                onClick={() => startGrabIntent('copy')}
                disabled={isBlankTab}
                aria-label="Grab page element"
              >
                <Crosshair className="size-4" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {`Grab page element (${navigator.userAgent.includes('Mac') ? '⌘C' : 'Ctrl+C'})`}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            {/* Why: wrap the disabled button in a span so pointer events still
                reach the tooltip trigger — Radix (and the DOM) drop hover
                events on disabled <button>, which is why the previous native
                `title` attribute fired inconsistently. */}
            <span className="inline-flex">
              <Button
                size="icon"
                variant={grab.state !== 'idle' && grabIntent === 'annotate' ? 'default' : 'ghost'}
                className={cn(
                  'relative h-8 w-8',
                  grab.state !== 'idle' &&
                    grabIntent === 'annotate' &&
                    'bg-foreground/80 text-background hover:bg-foreground/90'
                )}
                onClick={() => startGrabIntent('annotate')}
                disabled={isBlankTab}
                aria-label="Annotate page element"
              >
                <MessageSquarePlus className="size-4" />
                {browserAnnotations.length > 0 ? (
                  <span className="absolute -top-1 -right-1 flex min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] leading-4 text-primary-foreground">
                    {browserAnnotations.length}
                  </span>
                ) : null}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            Annotate page element
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
            grab.state === 'error' ? 'bg-destructive/10' : 'bg-accent'
          )}
        >
          <Crosshair
            className={cn(
              'size-3 shrink-0',
              grab.state === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          />
          <span className="min-w-0 flex-1 truncate">
            {grab.state === 'error'
              ? `Grab failed: ${grab.error ?? 'Unknown error'}`
              : grabIntent === 'annotate'
                ? pendingAnnotationPayload
                  ? 'Add feedback for the selected element.'
                  : browserAnnotations.length > 0
                    ? `${browserAnnotations.length} annotation${browserAnnotations.length === 1 ? '' : 's'} ready. Select another element or copy all feedback.`
                    : 'Click an element to add feedback for the agent.'
                : grab.state === 'confirming'
                  ? 'Copied — press S to screenshot, or select another element'
                  : 'Click or hover an element, then press C to copy or S to screenshot.'}
          </span>
          {grabIntent === 'annotate' && browserAnnotations.length > 0 ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="h-6 gap-1.5"
                onClick={handleCopyBrowserAnnotations}
              >
                {browserAnnotationsCopied ? (
                  <CircleCheck className="size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
                {browserAnnotationsCopied ? 'Copied' : 'Copy All'}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-6 w-6"
                onClick={handleClearBrowserAnnotations}
                aria-label="Clear browser annotations"
              >
                <Trash2 className="size-3" />
              </Button>
            </>
          ) : null}
          <button
            className="ml-auto shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              setPendingAnnotationPayload(null)
              grab.cancel()
            }}
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
        {pendingAnnotationPayload ? (
          <PendingBrowserAnnotationCard
            payload={pendingAnnotationPayload}
            anchor={getBrowserOverlayAnchor(
              pendingAnnotationPayload,
              containerRef.current,
              webviewRef.current,
              browserOverlayViewport
            )}
            portalContainer={containerRef.current}
            onAdd={handleAddBrowserAnnotation}
            onCancel={handleCancelPendingBrowserAnnotation}
          />
        ) : null}
        {browserAnnotations.length > 0 && browserAnnotationTrayOpen ? (
          <div className="absolute right-3 bottom-3 z-30 flex max-h-[45%] w-[min(20rem,calc(100%-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
            <div className="flex items-center gap-2 border-b border-border px-3 py-2">
              <MessageSquarePlus className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1 text-sm font-medium">
                {browserAnnotations.length} annotation{browserAnnotations.length === 1 ? '' : 's'}
              </div>
              <Button
                size="xs"
                variant="outline"
                className="gap-1.5"
                onClick={handleCopyBrowserAnnotations}
              >
                {browserAnnotationsCopied ? (
                  <CircleCheck className="size-3" />
                ) : (
                  <Copy className="size-3" />
                )}
                {browserAnnotationsCopied ? 'Copied' : 'Copy'}
              </Button>
              <Button
                size="icon-xs"
                variant="ghost"
                className="h-6 w-6 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={handleClearBrowserAnnotations}
                aria-label="Clear browser annotations"
              >
                <Trash2 className="size-3" />
              </Button>
            </div>
            <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto p-1.5">
              {browserAnnotations.map((annotation, index) => (
                <div
                  key={annotation.id}
                  className="group flex gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent focus-within:bg-accent"
                >
                  <div className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground">
                    {index + 1}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground">
                      {annotation.payload.target.accessibility.accessibleName ||
                        annotation.payload.target.textSnippet ||
                        annotation.payload.target.tagName}
                    </div>
                    <div className="mt-0.5 line-clamp-2 text-muted-foreground">
                      {annotation.comment}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span>{annotation.intent}</span>
                      <span>-</span>
                      <span>{annotation.priority}</span>
                    </div>
                  </div>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                    onClick={() => deleteBrowserPageAnnotation(browserTab.id, annotation.id)}
                    aria-label={`Delete annotation ${index + 1}`}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {/* Right-click context dropdown: positioned at the element's center,
            shown when grab.contextMenu is true (user right-clicked). */}
        <DropdownMenu
          open={grab.state === 'confirming' && grab.contextMenu && grabIntent === 'copy'}
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
              {grabToast.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
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
                    >
                      <Image className="size-3.5" />
                      Copy Screenshot
                      <DropdownMenuShortcut>S</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
