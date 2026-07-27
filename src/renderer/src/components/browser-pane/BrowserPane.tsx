/* eslint-disable max-lines */
/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: BrowserPane synchronizes Electron webviews, remote browser drivers, streams, downloads, and annotation overlays; those external lifecycles cannot be derived during render. */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent
} from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { getConnectionId } from '@/lib/connection-context'
import { detectLanguage } from '@/lib/language-detect'
import { isPathInsideWorktree, toWorktreeRelativePath } from '@/lib/terminal-links'
import { getWorkspaceFileBrowserOpenTarget } from '@/lib/file-preview'
import {
  getWorkspaceFileDragRejectionMessage,
  readWorkspaceFileDragPaths,
  WORKSPACE_FILE_PATH_MIME
} from '@/lib/workspace-file-drag'
import {
  ArrowLeft,
  ArrowRight,
  CircleCheck,
  Copy,
  CornerDownLeft,
  Crosshair,
  Download,
  ExternalLink,
  FolderOpen,
  Globe,
  Image,
  Loader2,
  MessageCircleQuestionMark,
  MessageSquarePlus,
  OctagonX,
  PencilLine,
  RefreshCw,
  Send,
  SquareCode,
  Trash2,
  X
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { BrowserAnnotationSendMenuContent } from './BrowserAnnotationSendMenuContent'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { ORCA_BROWSER_BLANK_URL, ORCA_BROWSER_PARTITION } from '../../../../shared/constants'
import { BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { getOrcaProfileBrowserDefaultPartition } from '../../../../shared/orca-profiles'
import type {
  BrowserCertificateProceedResult,
  BrowserLoadError,
  BrowserPage as BrowserPageState,
  BrowserWorkspace as BrowserWorkspaceState
} from '../../../../shared/types'
import {
  normalizeBrowserNavigationUrl,
  normalizeExternalBrowserUrl,
  redactKagiSessionToken,
  resolveRemoteFailureExternalUrl,
  toHttpsRecoveryUrl
} from '../../../../shared/browser-url'
import { keybindingMatchesAction } from '../../../../shared/keybindings'
import { getScreenSubmitModifierLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import {
  browserViewportPresetToOverride,
  getBrowserViewportPreset
} from '../../../../shared/browser-viewport-presets'
import { rememberLiveBrowserUrl } from './browser-runtime'
import { ensureBrowserPageWebview } from './browser-page-webview'
import {
  destroyPersistentWebview,
  moveFocusToRendererBeforeWebviewDetach,
  registeredWebContentsIds
} from './webview-registry'
import {
  applyBrowserPageViewportLayout,
  ensureBrowserPageViewport,
  getBrowserOverlaySlotViewport,
  parkBrowserPageViewport,
  subscribeBrowserOverlaySlotViewport,
  syncBrowserPageChromeInset
} from './browser-page-viewport'
import { useBrowserAutomationVisiblePageIds } from './browser-automation-visibility'
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
import { getBrowserPagesForWorkspace } from './browser-pane-page-selection'
import BrowserAddressBar from './BrowserAddressBar'
import { BrowserImportHintButton } from './BrowserImportHintButton'
import { BrowserToolbarMenu } from './BrowserToolbarMenu'
import BrowserFind from './BrowserFind'
import { BrowserMobileDriverOverlay } from './BrowserMobileDriverOverlay'
import { getShortcutPlatform, useShortcutLabel } from '@/hooks/useShortcutLabel'
import { getRemoteBrowserFrameStyle } from './remote-browser-frame-style'
import {
  getRemoteBrowserKeyboardShortcut,
  getRemoteBrowserKeypressKey
} from './remote-browser-keyboard'
import {
  consumeBrowserFocusRequest,
  ORCA_BROWSER_FOCUS_REQUEST_EVENT,
  type BrowserFocusRequestDetail
} from './browser-focus'
import {
  addBrowserPageZoomEventListener,
  applyBrowserPageZoom,
  browserPageZoomLevelToPercent,
  DEFAULT_BROWSER_PAGE_ZOOM_LEVEL,
  getBrowserPageZoomIndicatorState,
  normalizeBrowserPageZoomLevel,
  setBrowserPageZoomLevel,
  type BrowserPageZoomDirection
} from './browser-page-zoom'
import {
  isRemoteRuntimeFileOperation,
  statRuntimePath,
  type RuntimeFileOperationArgs
} from '@/runtime/runtime-file-client'
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  RuntimeRpcCallError,
  type RuntimeClientTarget
} from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  BrowserBackResult,
  BrowserGotoResult,
  BrowserReloadResult,
  BrowserScreencastResult,
  BrowserTabInfo,
  RuntimeStatus
} from '../../../../shared/runtime-types'
import {
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrameMetadata
} from '../../../../shared/browser-screencast-protocol'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../../shared/runtime-rpc-feature-interaction-source'
import { formatByteCount, formatPermissionNotice, formatPopupNotice } from './browser-notices'
import {
  getDriverForBrowserPage,
  onBrowserDriverChange,
  useBrowserMobileDrivenPageIds,
  type BrowserDriverState
} from '@/lib/pane-manager/browser-mobile-driver-state'
import { shouldPollChromiumErrorPage } from './chromium-error-page-polling'
import { useContextualTour } from '@/components/contextual-tours/use-contextual-tour'
import { translate } from '@/i18n/i18n'
import { isBrowserPagePanePaintable } from './browser-page-paintability'
import { useMarkupMode, type MarkupCaptureContext } from './markup/useMarkupMode'
import { MarkupOverlay } from './markup/MarkupOverlay'
import { MarkupDrawButton } from './markup/MarkupDrawButton'
import { deliverMarkupToClipboard } from './markup/markup-clipboard-delivery'
import { BrowserLoadFailureOverlay } from './browser-load-failure-overlay'

type BrowserTabPageState = Partial<
  Pick<
    BrowserPageState,
    'title' | 'loading' | 'faviconUrl' | 'canGoBack' | 'canGoForward' | 'loadError'
  >
>

type BrowserDownloadState = Omit<BrowserDownloadRequestedEvent, 'status' | 'savePath'> & {
  receivedBytes: number
  status: 'downloading' | 'completed' | 'failed' | 'canceled'
  savePath: string | null
  error: string | null
  progressState: BrowserDownloadProgressEvent['state']
  completedAt: number | null
}

function formatBrowserDownloadProgress(download: BrowserDownloadState): string | null {
  const received = formatByteCount(download.receivedBytes)
  const total = formatByteCount(download.totalBytes)
  if (received && total) {
    return `${received} / ${total}`
  }
  return received ?? total
}

type GrabIntent = 'copy' | 'annotate'

type BrowserOverlayAnchor = {
  x: number
  y: number
  below: boolean
}

const BROWSER_ANNOTATION_INTENT_OPTIONS = [
  {
    value: 'change',
    get label() {
      return translate('auto.components.browser.pane.BrowserPane.143204e423', 'Change')
    },
    icon: PencilLine
  },
  {
    value: 'question',
    get label() {
      return translate('auto.components.browser.pane.BrowserPane.b5ba6085de', 'Question')
    },
    icon: MessageCircleQuestionMark
  }
] as const

// Why: priority stays in the persisted annotation shape for backwards compat, though the UI no longer exposes urgency choices.
const DEFAULT_BROWSER_ANNOTATION_PRIORITY: BrowserAnnotationPriority = 'important'
const BROWSER_PAGE_ZOOM_FEEDBACK_MS = 1400

type BrowserOverlayViewport = {
  scrollX: number
  scrollY: number
  version: number
}

function decodeRemoteBrowserFrameUrl(url: string): Promise<void> {
  const image = new window.Image()
  image.decoding = 'async'
  image.src = url
  if (typeof image.decode === 'function') {
    return image.decode()
  }
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Remote browser frame failed to decode.'))
  })
}

type RemoteBrowserStreamToken = {
  tabId: string
  environmentId: string
  remotePageId: string
  generation: number
  operationGeneration: number
}

type RemoteBrowserStreamSubscription = {
  token: RemoteBrowserStreamToken
  unsubscribe: () => void
}

type RemoteBrowserOperationToken = {
  tabId: string
  environmentId: string
  remotePageId: string | null
  generation: number
}

type RemoteBrowserContextMenu = {
  x: number
  y: number
  linkUrl: string | null
  pageUrl: string
  selectionText: string
}

type RemoteBrowserViewportSize = {
  width: number
  height: number
}

function getBrowserPageRuntimeEnvironmentId(
  page: BrowserPageState,
  inferredRuntimeEnvironmentId: string | null | undefined
): string | null {
  if (page.browserRuntimeEnvironmentId !== undefined) {
    return page.browserRuntimeEnvironmentId?.trim() || null
  }
  return inferredRuntimeEnvironmentId?.trim() || null
}

type RemoteBrowserImagePoint = {
  x: number
  y: number
}

type PendingRemoteBrowserWheel = {
  target: RuntimeClientTarget & { kind: 'environment' }
  pageId: string
  operationToken: RemoteBrowserOperationToken
  point: RemoteBrowserImagePoint
  dx: number
  dy: number
}

const EMPTY_BROWSER_ANNOTATIONS: BrowserPageAnnotation[] = []
const PENDING_ANNOTATION_CARD_HEIGHT = 330
const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2

function createBrowserAnnotationId(): string {
  return `browser-annotation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function createBrowserAnnotationPayload(payload: BrowserGrabPayload): BrowserAnnotationPayload {
  return {
    ...payload,
    // Why: annotations are persisted; screenshot data is a transient copy payload that can be megabytes per selection.
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
  onAdd: (comment: string, intent: BrowserAnnotationIntent) => void
  onCancel: () => void
}): React.JSX.Element {
  const [comment, setComment] = useState('')
  const [intent, setIntent] = useState<BrowserAnnotationIntent>('change')
  const trimmed = comment.trim()
  const submitModifierLabel = getScreenSubmitModifierLabel()

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
        aria-label={translate(
          'auto.components.browser.pane.BrowserPane.b472c5fe03',
          'Add browser annotation'
        )}
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
          {translate('auto.components.browser.pane.BrowserPane.d2a7092e6e', 'Annotation comment')}
        </Label>
        <textarea
          id="browser-annotation-comment"
          value={comment}
          onChange={(event) => setComment(event.target.value)}
          placeholder={translate(
            'auto.components.browser.pane.BrowserPane.532bac48c5',
            'Describe what the agent should change here...'
          )}
          maxLength={GRAB_BUDGET.annotationCommentMaxLength}
          className="h-24 w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          autoFocus
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              onCancel()
              return
            }
            if (isScreenSubmitShortcut(event)) {
              event.preventDefault()
              event.stopPropagation()
              if (trimmed) {
                onAdd(trimmed, intent)
              }
            }
          }}
        />
        <div className="mt-2 min-w-0">
          <Label className="mb-1 block text-xs text-muted-foreground">
            {translate('auto.components.browser.pane.BrowserPane.8f87e6c2e5', 'Intent')}
          </Label>
          <ToggleGroup
            type="single"
            size="sm"
            variant="outline"
            value={intent}
            onValueChange={(value) => {
              if (value) {
                setIntent(value as BrowserAnnotationIntent)
              }
            }}
            className="h-8 w-full [&_[data-slot=toggle-group-item]]:h-8 [&_[data-slot=toggle-group-item]]:flex-1 [&_[data-slot=toggle-group-item]]:px-2"
            aria-label={translate(
              'auto.components.browser.pane.BrowserPane.0cb3bd6221',
              'Annotation intent'
            )}
          >
            {BROWSER_ANNOTATION_INTENT_OPTIONS.map((option) => {
              const Icon = option.icon
              return (
                <ToggleGroupItem
                  key={option.value}
                  value={option.value}
                  aria-label={option.label}
                  className="gap-1.5 text-xs data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground"
                >
                  <Icon className="size-3.5" />
                  <span>{option.label}</span>
                </ToggleGroupItem>
              )
            })}
          </ToggleGroup>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>
            {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
          </Button>
          <Button
            size="sm"
            className="h-8 gap-1.5"
            disabled={!trimmed}
            onClick={() => onAdd(trimmed, intent)}
          >
            <MessageSquarePlus className="size-3.5" />
            {translate('auto.components.browser.pane.BrowserPane.90d021f2ad', 'Add')}
            <span className="ml-1 inline-flex items-center gap-0.5 rounded border border-white/20 px-1.5 py-0.5 text-[10px] font-medium leading-none text-current/80">
              <span>{submitModifierLabel}</span>
              <CornerDownLeft className="size-3" />
            </span>
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function browserPageExists(tabId: string): boolean {
  return Object.values(useAppStore.getState().browserPagesByWorkspace).some((pages) =>
    pages.some((page) => page.id === tabId)
  )
}

function isRemoteBrowserPageMissingError(error: unknown): boolean {
  if (error instanceof RuntimeRpcCallError) {
    return isRemoteBrowserPageMissingCode(error.code)
  }
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return false
  }
  return isRemoteBrowserPageMissingCode((error as { code: unknown }).code)
}

function isRemoteBrowserPageMissingCode(code: unknown): boolean {
  return code === 'browser_tab_not_found' || code === 'browser_no_tab'
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

function getRemoteBrowserMouseButton(button: number): 'left' | 'middle' | 'right' | null {
  if (button === 0) {
    return 'left'
  }
  if (button === 1) {
    return 'middle'
  }
  if (button === 2) {
    return 'right'
  }
  return null
}

function buildRemoteContextMenuExpression(x: number, y: number): string {
  return `(() => {
    const target = document.elementFromPoint(${JSON.stringify(x)}, ${JSON.stringify(y)});
    const anchor = target && typeof target.closest === 'function' ? target.closest('a[href]') : null;
    // Why: read the guest selection here so the remote/paired browser can offer
    // the same Copy affordance as the local webview (there is no ContextMenuParams
    // over the runtime RPC).
    const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
    return JSON.stringify({
      linkUrl: anchor && anchor.href ? anchor.href : null,
      pageUrl: location.href || 'about:blank',
      selectionText: selection ? String(selection) : ''
    });
  })()`
}

function readRemoteContextMenuResult(
  result: unknown
): Pick<RemoteBrowserContextMenu, 'linkUrl' | 'pageUrl' | 'selectionText'> | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const raw = (result as { result?: unknown }).result
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as {
      linkUrl?: unknown
      pageUrl?: unknown
      selectionText?: unknown
    }
    return {
      linkUrl: typeof parsed.linkUrl === 'string' && parsed.linkUrl ? parsed.linkUrl : null,
      pageUrl:
        typeof parsed.pageUrl === 'string' && parsed.pageUrl ? parsed.pageUrl : 'about:blank',
      selectionText: typeof parsed.selectionText === 'string' ? parsed.selectionText : ''
    }
  } catch {
    return null
  }
}

function readRemoteCssViewportSize(result: unknown): RemoteBrowserViewportSize | null {
  if (!result || typeof result !== 'object') {
    return null
  }
  const raw = (result as { result?: unknown }).result
  if (typeof raw !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(raw) as { width?: unknown; height?: unknown }
    const width = getPositiveFiniteNumber(parsed.width)
    const height = getPositiveFiniteNumber(parsed.height)
    return width && height ? { width, height } : null
  } catch {
    return null
  }
}

function getPositiveFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function areRemoteViewportSizesNear(
  a: RemoteBrowserViewportSize | null,
  b: RemoteBrowserViewportSize | null
): boolean {
  if (!a || !b) {
    return false
  }
  return Math.abs(a.width - b.width) <= 3 && Math.abs(a.height - b.height) <= 3
}

function getRemoteBrowserDeviceScaleFactor(): number {
  if (typeof window === 'undefined') {
    return 1
  }
  const scale = Number.isFinite(window.devicePixelRatio) ? window.devicePixelRatio : 1
  return Math.min(2, Math.max(1, Number(scale.toFixed(2))))
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
      // Why: querying nav state before dom-ready throws and blanks the whole IDE on launch; fall back to the persisted URL.
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
      // Why: toolbar actions need a stable URL during early guest attach/restore; fall back to the persisted URL instead of throwing.
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

  // Why: after chrome-error://, reload() only refreshes the error page — force navigation back to the attempted URL; keep the failure visible until success.
  onUpdatePageState(browserTab.id, {
    loading: true,
    title: retryUrl
  })
  webview.src = retryUrl
}

export default function BrowserPane({
  browserTab,
  isActive
}: {
  browserTab: BrowserWorkspaceState
  isActive: boolean
}): React.JSX.Element {
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    getRuntimeEnvironmentIdForWorktree(s, browserTab.worktreeId)
  )
  const browserPages = useAppStore((s) =>
    getBrowserPagesForWorkspace(s.browserPagesByWorkspace, browserTab.id)
  )
  const activeBrowserPage =
    browserPages.find((page) => page.id === browserTab.activePageId) ?? browserPages[0] ?? null
  const updateBrowserPageState = useAppStore((s) => s.updateBrowserPageState)
  const setBrowserPageUrl = useAppStore((s) => s.setBrowserPageUrl)
  const activeBrowserRuntimeEnvironmentId = activeBrowserPage
    ? getBrowserPageRuntimeEnvironmentId(activeBrowserPage, activeRuntimeEnvironmentId)
    : null
  const runtimeEnvironmentActive = Boolean(activeBrowserRuntimeEnvironmentId)
  const activeBrowserPageId = activeBrowserPage?.id ?? null
  const browserPageIds = useMemo(() => browserPages.map((page) => page.id), [browserPages])
  const automationVisiblePageIds = useBrowserAutomationVisiblePageIds(browserPageIds)
  const mobileDrivenPageIds = useBrowserMobileDrivenPageIds(browserPageIds)
  // Why: inactive webviews must stay mounted in their original DOM parent; unmounting/reparenting loses form text and SPA state.
  const renderedBrowserPages = browserPages.filter(
    (page) => !getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)
  )
  const [activeBrowserDriver, setActiveBrowserDriver] = useState<BrowserDriverState>({
    kind: 'idle'
  })

  useEffect(() => {
    if (!runtimeEnvironmentActive) {
      return
    }
    for (const page of browserPages) {
      if (getBrowserPageRuntimeEnvironmentId(page, activeRuntimeEnvironmentId)) {
        destroyPersistentWebview(page.id)
      }
    }
  }, [activeRuntimeEnvironmentId, browserPages, runtimeEnvironmentActive])

  useEffect(() => {
    if (runtimeEnvironmentActive || !activeBrowserPageId) {
      setActiveBrowserDriver({ kind: 'idle' })
      return
    }
    setActiveBrowserDriver(getDriverForBrowserPage(activeBrowserPageId))
    return onBrowserDriverChange((event) => {
      if (event.browserPageId === activeBrowserPageId) {
        setActiveBrowserDriver(event.driver)
      }
    })
  }, [activeBrowserPageId, runtimeEnvironmentActive])

  useContextualTour(
    'browser',
    isActive && activeBrowserPage !== null && !runtimeEnvironmentActive,
    'browser_visible'
  )

  const reclaimActiveBrowserForDesktop = useCallback(async (): Promise<void> => {
    if (!activeBrowserPageId) {
      return
    }
    await window.api.runtime.reclaimBrowserForDesktop(activeBrowserPageId)
  }, [activeBrowserPageId])

  if (activeBrowserRuntimeEnvironmentId) {
    return activeBrowserPage ? (
      <RemoteBrowserPagePane
        key={`${activeBrowserRuntimeEnvironmentId ?? ''}:${activeBrowserPage.id}`}
        browserTab={activeBrowserPage}
        runtimeEnvironmentId={activeBrowserRuntimeEnvironmentId}
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
      {renderedBrowserPages.length > 0 ? (
        <div className="relative flex min-h-0 flex-1">
          {renderedBrowserPages.map((page) => (
            <BrowserPagePane
              key={page.id}
              browserTab={page}
              workspaceId={browserTab.id}
              worktreeId={browserTab.worktreeId}
              sessionProfileId={browserTab.sessionProfileId ?? null}
              sessionPartition={browserTab.sessionPartition ?? null}
              isActive={isActive && page.id === activeBrowserPage?.id}
              isAutomationVisible={automationVisiblePageIds.has(page.id)}
              isMobileDriven={mobileDrivenPageIds.has(page.id)}
              inputLocked={activeBrowserDriver.kind === 'mobile'}
              onUpdatePageState={updateBrowserPageState}
              onSetUrl={setBrowserPageUrl}
            />
          ))}
          <BrowserMobileDriverOverlay
            driver={activeBrowserDriver}
            onTakeBack={reclaimActiveBrowserForDesktop}
          />
        </div>
      ) : null}
    </div>
  )
}

function RemoteBrowserPagePane({
  browserTab,
  runtimeEnvironmentId,
  worktreeId,
  isActive,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  runtimeEnvironmentId: string
  worktreeId: string
  isActive: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: (tabId: string, url: string) => void
}): React.JSX.Element {
  const activeRuntimeEnvironmentId = runtimeEnvironmentId
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const imageRef = useRef<HTMLImageElement | null>(null)
  const remoteViewportRef = useRef<HTMLDivElement | null>(null)
  const [addressBarValue, setAddressBarValue] = useState(toDisplayUrl(browserTab.url))
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameMetadata, setFrameMetadata] = useState<BrowserScreencastFrameMetadata | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<RemoteBrowserContextMenu | null>(null)
  const [busy, setBusy] = useState(false)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const remotePageIdRef = useRef<string | null>(null)
  const remoteViewportSizeRef = useRef<RemoteBrowserViewportSize | null>(null)
  const remoteCssViewportSizeRef = useRef<RemoteBrowserViewportSize | null>(null)
  const remoteStreamViewportSizeRef = useRef<RemoteBrowserViewportSize | null>(null)
  const remoteViewportTimerRef = useRef<number | null>(null)
  const streamFrameUrlRef = useRef<string | null>(null)
  const streamSubscriptionRef = useRef<RemoteBrowserStreamSubscription | null>(null)
  const streamRestartTimerRef = useRef<number | null>(null)
  const remoteTabRefreshTimerRef = useRef<number | null>(null)
  const remoteInputQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRemoteWheelRef = useRef<PendingRemoteBrowserWheel | null>(null)
  const remoteWheelFrameRef = useRef<number | null>(null)
  const remoteWheelInFlightRef = useRef(false)
  const pendingFrameDecodeRef = useRef(0)
  const streamGenerationRef = useRef(0)
  const remoteOperationGenerationRef = useRef(0)
  const activeStreamTokenRef = useRef<RemoteBrowserStreamToken | null>(null)
  const mountedRef = useRef(true)
  const isActiveRef = useRef(isActive)
  const currentBrowserTabIdRef = useRef(browserTab.id)
  const currentBrowserTabUrlRef = useRef(browserTab.url)
  const runtimeWorktree = useMemo(() => toRuntimeWorktreeSelector(worktreeId), [worktreeId])
  const activeRuntimeEnvironmentIdRef = useRef<string | null>(activeRuntimeEnvironmentId)
  const startRemoteStreamRef = useRef<
    (pageId: string) => Promise<RemoteBrowserStreamSubscription | null>
  >(async () => null)
  const restartRemoteStreamForViewportRef = useRef<(pageId: string) => void>(() => {})
  const fetchRemoteTabInfoRef = useRef<
    (token: RemoteBrowserOperationToken) => Promise<BrowserTabInfo | null>
  >(async () => null)
  const setRemoteBrowserPageHandle = useAppStore((s) => s.setRemoteBrowserPageHandle)
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const remotePageHandle = useAppStore(
    (s) => s.remoteBrowserPageHandlesByPageId[browserTab.id] ?? null
  )
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const closeBrowserPage = useAppStore((s) => s.closeBrowserPage)
  const closeBrowserTab = useAppStore((s) => s.closeBrowserTab)
  const keybindings = useAppStore((state) => state.keybindings)

  // Why: runtimes predating browser.certificate-trust.v1 can't honor a proceed request, so hide "Proceed Anyway" until support is advertised.
  const [remoteCertificateTrustSupported, setRemoteCertificateTrustSupported] = useState(false)
  const remoteCertificateEnvironmentId = remotePageHandle?.environmentId ?? null
  const certificateChallengeId = certificateFailure?.challengeId ?? null
  useEffect(() => {
    if (!remoteCertificateEnvironmentId || !certificateChallengeId) {
      setRemoteCertificateTrustSupported(false)
      return
    }
    let cancelled = false
    void runtimeEnvironmentSupportsCapability(
      remoteCertificateEnvironmentId,
      BROWSER_CERTIFICATE_TRUST_RUNTIME_CAPABILITY
    )
      .then((supported) => {
        if (!cancelled) {
          setRemoteCertificateTrustSupported(supported)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRemoteCertificateTrustSupported(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [remoteCertificateEnvironmentId, certificateChallengeId])

  currentBrowserTabIdRef.current = browserTab.id
  currentBrowserTabUrlRef.current = browserTab.url
  activeRuntimeEnvironmentIdRef.current = activeRuntimeEnvironmentId
  isActiveRef.current = isActive

  const runtimeTarget = useCallback(() => {
    return activeRuntimeEnvironmentId
      ? ({
          kind: 'environment',
          environmentId: activeRuntimeEnvironmentId
        } satisfies RuntimeClientTarget)
      : null
  }, [activeRuntimeEnvironmentId])

  const clearStreamFrame = useCallback((): void => {
    pendingFrameDecodeRef.current += 1
    const prevUrl = streamFrameUrlRef.current
    streamFrameUrlRef.current = null
    remoteCssViewportSizeRef.current = null
    remoteStreamViewportSizeRef.current = null
    setFrameMetadata(null)
    setFrameUrl(null)
    if (prevUrl) {
      URL.revokeObjectURL(prevUrl)
    }
  }, [])

  const clearPendingRemoteWheel = useCallback((): void => {
    pendingRemoteWheelRef.current = null
    remoteWheelInFlightRef.current = false
    if (remoteWheelFrameRef.current !== null) {
      window.cancelAnimationFrame(remoteWheelFrameRef.current)
      remoteWheelFrameRef.current = null
    }
  }, [])

  const closeMissingRemotePage = useCallback(
    (remotePageId: string | null = remotePageIdRef.current): void => {
      const state = useAppStore.getState()
      if (remotePageId) {
        state.removeRemoteBrowserPageHandle(browserTab.id, remotePageId)
      }
      remotePageIdRef.current = null
      remoteOperationGenerationRef.current += 1
      streamGenerationRef.current += 1
      activeStreamTokenRef.current = null
      streamSubscriptionRef.current?.unsubscribe()
      streamSubscriptionRef.current = null
      if (streamRestartTimerRef.current !== null) {
        window.clearTimeout(streamRestartTimerRef.current)
        streamRestartTimerRef.current = null
      }
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
      if (remoteTabRefreshTimerRef.current !== null) {
        window.clearTimeout(remoteTabRefreshTimerRef.current)
        remoteTabRefreshTimerRef.current = null
      }
      remoteInputQueueRef.current = Promise.resolve()
      clearStreamFrame()
      setRemoteError(null)
      setBusy(false)
      // Why: a runtime-side tab close mirrors closing the visible tab; don't leave a dead pane behind.
      const workspacePageCount = state.browserPagesByWorkspace[browserTab.workspaceId]?.length ?? 0
      if (workspacePageCount <= 1) {
        closeBrowserTab(browserTab.workspaceId)
        return
      }
      closeBrowserPage(browserTab.id)
    },
    [browserTab.id, browserTab.workspaceId, clearStreamFrame, closeBrowserPage, closeBrowserTab]
  )

  const rememberRemoteViewportSize = useCallback(
    (next: RemoteBrowserViewportSize): RemoteBrowserViewportSize => {
      const prev = remoteViewportSizeRef.current
      if (
        !prev ||
        Math.abs(prev.width - next.width) > 3 ||
        Math.abs(prev.height - next.height) > 3
      ) {
        remoteViewportSizeRef.current = next
        return next
      }
      return prev
    },
    []
  )

  const readCurrentRemoteViewportSize = useCallback((): RemoteBrowserViewportSize | null => {
    const element = remoteViewportRef.current
    if (!element) {
      return null
    }
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) {
      return null
    }
    return {
      width: Math.max(320, Math.round(rect.width)),
      height: Math.max(240, Math.round(rect.height))
    }
  }, [])

  const readRemoteViewportSize = useCallback((): RemoteBrowserViewportSize | null => {
    const next = readCurrentRemoteViewportSize()
    return next ? rememberRemoteViewportSize(next) : remoteViewportSizeRef.current
  }, [readCurrentRemoteViewportSize, rememberRemoteViewportSize])

  const waitForRemoteViewportSize =
    useCallback(async (): Promise<RemoteBrowserViewportSize | null> => {
      for (let i = 0; i < 3; i += 1) {
        const next = readCurrentRemoteViewportSize()
        if (next) {
          return rememberRemoteViewportSize(next)
        }
        await new Promise<void>((resolve) => {
          window.requestAnimationFrame(() => resolve())
        })
      }
      return readRemoteViewportSize()
    }, [readCurrentRemoteViewportSize, readRemoteViewportSize, rememberRemoteViewportSize])

  const syncRemoteViewport = useCallback(
    async (pageId: string): Promise<void> => {
      const target = runtimeTarget()
      const size = readRemoteViewportSize()
      if (!target || !size) {
        return
      }
      await callRuntimeRpc(
        target,
        'browser.viewport',
        {
          worktree: runtimeWorktree,
          page: pageId,
          width: size.width,
          height: size.height,
          deviceScaleFactor: getRemoteBrowserDeviceScaleFactor(),
          mobile: false
        },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      )
      try {
        // Why: the streamed bitmap can include the host compositor surface, but CDP input wants the guest page's CSS viewport coords.
        const viewport = await callRuntimeRpc(
          target,
          'browser.eval',
          {
            worktree: runtimeWorktree,
            page: pageId,
            expression: 'JSON.stringify({ width: window.innerWidth, height: window.innerHeight })'
          },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        remoteCssViewportSizeRef.current = readRemoteCssViewportSize(viewport) ?? size
      } catch {
        remoteCssViewportSizeRef.current = size
      }
    },
    [readRemoteViewportSize, runtimeTarget, runtimeWorktree]
  )

  const enqueueRemoteInput = useCallback((operation: () => Promise<void>): Promise<void> => {
    const next = remoteInputQueueRef.current.catch(() => {}).then(operation)
    remoteInputQueueRef.current = next.catch(() => {})
    return next
  }, [])

  const createRemoteOperationToken = useCallback(
    (remotePageId: string | null = null): RemoteBrowserOperationToken | null => {
      const target = runtimeTarget()
      if (!target) {
        return null
      }
      return {
        tabId: browserTab.id,
        environmentId: target.environmentId,
        remotePageId,
        generation: remoteOperationGenerationRef.current
      }
    },
    [browserTab.id, runtimeTarget]
  )

  const isCurrentRemoteOperationToken = useCallback(
    (token: RemoteBrowserOperationToken): boolean =>
      mountedRef.current &&
      isActiveRef.current &&
      browserPageExists(token.tabId) &&
      currentBrowserTabIdRef.current === token.tabId &&
      activeRuntimeEnvironmentIdRef.current === token.environmentId &&
      remoteOperationGenerationRef.current === token.generation &&
      (token.remotePageId === null || remotePageIdRef.current === token.remotePageId),
    []
  )

  const isCurrentRemoteStreamOperation = useCallback(
    (token: RemoteBrowserStreamToken): boolean =>
      isCurrentRemoteOperationToken({
        tabId: token.tabId,
        environmentId: token.environmentId,
        remotePageId: token.remotePageId,
        generation: token.operationGeneration
      }),
    [isCurrentRemoteOperationToken]
  )

  const isCurrentRemoteStreamToken = useCallback(
    (token: RemoteBrowserStreamToken): boolean => {
      const activeToken = activeStreamTokenRef.current
      return (
        activeToken?.generation === token.generation &&
        activeToken.operationGeneration === token.operationGeneration &&
        activeToken.tabId === token.tabId &&
        activeToken.environmentId === token.environmentId &&
        activeToken.remotePageId === token.remotePageId &&
        isCurrentRemoteStreamOperation(token)
      )
    },
    [isCurrentRemoteStreamOperation]
  )

  useEffect(() => {
    // Why: StrictMode's mount→cleanup→mount leaves mountedRef false; re-arm or operation tokens read stale and the pane wedges.
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      remoteOperationGenerationRef.current += 1
      streamGenerationRef.current += 1
      pendingFrameDecodeRef.current += 1
      activeStreamTokenRef.current = null
      remoteStreamViewportSizeRef.current = null
      if (streamRestartTimerRef.current !== null) {
        window.clearTimeout(streamRestartTimerRef.current)
        streamRestartTimerRef.current = null
      }
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
      if (remoteTabRefreshTimerRef.current !== null) {
        window.clearTimeout(remoteTabRefreshTimerRef.current)
        remoteTabRefreshTimerRef.current = null
      }
      clearPendingRemoteWheel()
      restartRemoteStreamForViewportRef.current = () => {}
      if (streamFrameUrlRef.current) {
        URL.revokeObjectURL(streamFrameUrlRef.current)
        streamFrameUrlRef.current = null
      }
    }
  }, [clearPendingRemoteWheel])

  useEffect(() => {
    // Why: only reset frame/wheel on identity change; bumping the stream/operation generations here races the streaming effect and wedges the pane.
    remoteStreamViewportSizeRef.current = null
    clearPendingRemoteWheel()
    clearStreamFrame()
  }, [activeRuntimeEnvironmentId, browserTab.id, clearPendingRemoteWheel, clearStreamFrame])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const element = remoteViewportRef.current
    if (!element) {
      return
    }
    const scheduleSync = (): void => {
      readRemoteViewportSize()
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
      }
      remoteViewportTimerRef.current = window.setTimeout(() => {
        remoteViewportTimerRef.current = null
        const pageId = remotePageIdRef.current
        if (!pageId || !isActiveRef.current) {
          return
        }
        void syncRemoteViewport(pageId)
          .then(() => restartRemoteStreamForViewportRef.current(pageId))
          .catch(() => {})
      }, 150)
    }
    scheduleSync()
    const observer = new ResizeObserver(scheduleSync)
    observer.observe(element)
    return () => {
      observer.disconnect()
      if (remoteViewportTimerRef.current !== null) {
        window.clearTimeout(remoteViewportTimerRef.current)
        remoteViewportTimerRef.current = null
      }
    }
  }, [isActive, readRemoteViewportSize, syncRemoteViewport])

  useEffect(() => {
    if (document.activeElement === addressBarInputRef.current) {
      return
    }
    setAddressBarValue(toDisplayUrl(browserTab.url))
  }, [browserTab.url])

  useEffect(() => {
    if (!contextMenu) {
      return
    }
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setContextMenu(null)
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [contextMenu])

  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el || !contextMenu) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()
    const offsetX = contextMenu.x - rect.left
    const offsetY = contextMenu.y - rect.top
    let renderX = contextMenu.x
    let renderY = contextMenu.y
    if (rect.right > window.innerWidth) {
      renderX = contextMenu.x - rect.width
    }
    if (rect.bottom > window.innerHeight) {
      renderY = contextMenu.y - rect.height
    }
    el.style.left = `${Math.max(0, renderX) + offsetX}px`
    el.style.top = `${Math.max(0, renderY) + offsetY}px`
  }, [contextMenu])

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
      const currentEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      const pageStillExists = browserPageExists(browserTab.id)
      if (currentEnvironmentId === activeRuntimeEnvironmentId && pageStillExists) {
        return
      }
      const removedHandle = state.removeRemoteBrowserPageHandle(browserTab.id, remotePageId)
      remotePageIdRef.current = null
      if (!removedHandle) {
        return
      }
      // Why: remote tabs outlive React components on the daemon; close only when the local page or its runtime environment is gone.
      void callRuntimeRpc(
        { kind: 'environment', environmentId: removedHandle.environmentId },
        'browser.tabClose',
        { worktree: runtimeWorktree, page: removedHandle.remotePageId },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      ).catch(() => {})
    }
  }, [activeRuntimeEnvironmentId, browserTab.id, runtimeWorktree, worktreeId])

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
    [browserTab.id, onSetUrl, onUpdatePageState]
  )

  const updateStreamFrame = useCallback(
    (token: RemoteBrowserStreamToken, bytes: Uint8Array<ArrayBufferLike>): void => {
      if (!isCurrentRemoteStreamToken(token)) {
        return
      }
      const frame = decodeBrowserScreencastFrame(bytes)
      if (!frame) {
        return
      }
      const imageBuffer = frame.image.buffer.slice(
        frame.image.byteOffset,
        frame.image.byteOffset + frame.image.byteLength
      ) as ArrayBuffer
      const nextUrl = URL.createObjectURL(
        new Blob([imageBuffer], { type: `image/${frame.format}` })
      )
      const decodeGeneration = pendingFrameDecodeRef.current + 1
      pendingFrameDecodeRef.current = decodeGeneration
      void decodeRemoteBrowserFrameUrl(nextUrl)
        .then(() => {
          if (
            pendingFrameDecodeRef.current !== decodeGeneration ||
            !isCurrentRemoteStreamToken(token)
          ) {
            URL.revokeObjectURL(nextUrl)
            return
          }
          const prevUrl = streamFrameUrlRef.current
          streamFrameUrlRef.current = nextUrl
          setFrameMetadata(frame.metadata)
          setFrameUrl(nextUrl)
          setBusy(false)
          if (prevUrl) {
            URL.revokeObjectURL(prevUrl)
          }
        })
        .catch(() => {
          URL.revokeObjectURL(nextUrl)
        })
    },
    [isCurrentRemoteStreamToken]
  )

  const getRemoteImagePoint = useCallback(
    (event: { clientX: number; clientY: number }): { x: number; y: number } | null => {
      const image = imageRef.current
      const viewport = remoteViewportRef.current
      if (!image || !viewport) {
        return null
      }
      const rect = viewport.getBoundingClientRect()
      const viewportWidth =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.width) ??
        getPositiveFiniteNumber(frameMetadata?.deviceWidth) ??
        image.naturalWidth
      const viewportHeight =
        getPositiveFiniteNumber(remoteCssViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(remoteViewportSizeRef.current?.height) ??
        getPositiveFiniteNumber(frameMetadata?.deviceHeight) ??
        image.naturalHeight
      if (rect.width <= 0 || rect.height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
        return null
      }
      return {
        x: Math.round(((event.clientX - rect.left) / rect.width) * viewportWidth),
        y: Math.round(((event.clientY - rect.top) / rect.height) * viewportHeight)
      }
    },
    [frameMetadata]
  )

  const ensureRemotePage = useCallback(
    async (token: RemoteBrowserOperationToken): Promise<string | null> => {
      if (!isCurrentRemoteOperationToken(token)) {
        return null
      }
      const target = { kind: 'environment' as const, environmentId: token.environmentId }
      const createRemotePage = async (): Promise<string | null> => {
        const currentUrl = currentBrowserTabUrlRef.current
        const initialUrl =
          currentUrl === ORCA_BROWSER_BLANK_URL ? 'about:blank' : currentUrl || 'about:blank'
        const created = await callRuntimeRpc<{ browserPageId: string }>(
          target,
          'browser.tabCreate',
          { worktree: runtimeWorktree, url: initialUrl },
          { timeoutMs: 30_000, suppressFeatureInteraction: true }
        )
        if (!isCurrentRemoteOperationToken(token)) {
          void callRuntimeRpc(
            target,
            'browser.tabClose',
            { worktree: runtimeWorktree, page: created.browserPageId },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          ).catch(() => {})
          return null
        }
        remotePageIdRef.current = created.browserPageId
        setRemoteBrowserPageHandle(browserTab.id, {
          environmentId: target.environmentId,
          remotePageId: created.browserPageId
        })
        return created.browserPageId
      }

      const existingHandle = useAppStore.getState().remoteBrowserPageHandlesByPageId[browserTab.id]
      if (existingHandle?.environmentId === target.environmentId) {
        const cachedToken = { ...token, remotePageId: existingHandle.remotePageId }
        remotePageIdRef.current = existingHandle.remotePageId
        try {
          const cachedTab = await fetchRemoteTabInfoRef.current(cachedToken)
          if (!cachedTab) {
            return null
          }
          return existingHandle.remotePageId
        } catch (error) {
          if (!isRemoteBrowserPageMissingError(error)) {
            throw error
          }
          useAppStore
            .getState()
            .removeRemoteBrowserPageHandle(browserTab.id, existingHandle.remotePageId)
          if (remotePageIdRef.current === existingHandle.remotePageId) {
            remotePageIdRef.current = null
          }
          if (!isCurrentRemoteOperationToken(token)) {
            return null
          }
          closeMissingRemotePage(existingHandle.remotePageId)
          return null
        }
      }
      return createRemotePage()
    },
    [
      browserTab.id,
      closeMissingRemotePage,
      isCurrentRemoteOperationToken,
      setRemoteBrowserPageHandle,
      runtimeWorktree
    ]
  )

  const fetchRemoteTabInfo = useCallback(
    async (token: RemoteBrowserOperationToken): Promise<BrowserTabInfo | null> => {
      if (!isCurrentRemoteOperationToken(token) || !token.remotePageId) {
        return null
      }
      const shown = await callRuntimeRpc<{ tab: BrowserTabInfo }>(
        { kind: 'environment', environmentId: token.environmentId },
        'browser.tabShow',
        { worktree: runtimeWorktree, page: token.remotePageId },
        { timeoutMs: 15_000, suppressFeatureInteraction: true }
      )
      return shown.tab
    },
    [isCurrentRemoteOperationToken, runtimeWorktree]
  )
  fetchRemoteTabInfoRef.current = fetchRemoteTabInfo

  const scheduleRemoteTabInfoRefresh = useCallback(
    (token: RemoteBrowserOperationToken, delayMs = 250): void => {
      if (!isCurrentRemoteOperationToken(token)) {
        return
      }
      if (remoteTabRefreshTimerRef.current !== null) {
        window.clearTimeout(remoteTabRefreshTimerRef.current)
      }
      remoteTabRefreshTimerRef.current = window.setTimeout(() => {
        remoteTabRefreshTimerRef.current = null
        if (!isCurrentRemoteOperationToken(token)) {
          return
        }
        void fetchRemoteTabInfo(token)
          .then((tab) => {
            if (tab && isCurrentRemoteOperationToken(token)) {
              applyRemoteTabInfo(tab)
            }
          })
          .catch((error: unknown) => {
            if (isCurrentRemoteOperationToken(token) && isRemoteBrowserPageMissingError(error)) {
              closeMissingRemotePage(token.remotePageId)
            }
          })
      }, delayMs)
    },
    [applyRemoteTabInfo, closeMissingRemotePage, fetchRemoteTabInfo, isCurrentRemoteOperationToken]
  )

  const scheduleRemoteStreamRestart = useCallback(
    (token: RemoteBrowserStreamToken): void => {
      if (!isCurrentRemoteStreamOperation(token) || streamRestartTimerRef.current !== null) {
        return
      }
      streamRestartTimerRef.current = window.setTimeout(() => {
        streamRestartTimerRef.current = null
        if (!isCurrentRemoteStreamOperation(token)) {
          return
        }
        setBusy(true)
        const operationToken: RemoteBrowserOperationToken = {
          tabId: token.tabId,
          environmentId: token.environmentId,
          remotePageId: token.remotePageId,
          generation: token.operationGeneration
        }
        void fetchRemoteTabInfo(operationToken)
          .then((tab) => {
            if (!tab || !isCurrentRemoteStreamOperation(token)) {
              return
            }
            applyRemoteTabInfo(tab)
          })
          .catch(() => {})
          .then(() => {
            if (!isCurrentRemoteStreamOperation(token)) {
              return null
            }
            return startRemoteStreamRef.current(token.remotePageId)
          })
          .then((subscription) => {
            if (!subscription) {
              return
            }
            if (!isCurrentRemoteStreamToken(subscription.token)) {
              subscription?.unsubscribe()
              return
            }
            streamSubscriptionRef.current = subscription
          })
          .catch((error: unknown) => {
            if (!isCurrentRemoteStreamOperation(token)) {
              return
            }
            if (isRemoteBrowserPageMissingError(error)) {
              closeMissingRemotePage(token.remotePageId)
              return
            }
            setRemoteError(
              error instanceof Error ? error.message : 'Failed to restart remote browser stream.'
            )
            setBusy(false)
          })
      }, 500)
    },
    [
      applyRemoteTabInfo,
      closeMissingRemotePage,
      fetchRemoteTabInfo,
      isCurrentRemoteStreamOperation,
      isCurrentRemoteStreamToken
    ]
  )

  const handleRemoteStreamClosed = useCallback(
    (token: RemoteBrowserStreamToken, restart: boolean): void => {
      if (!isCurrentRemoteStreamToken(token)) {
        return
      }
      setBusy(restart)
      const current = streamSubscriptionRef.current
      streamSubscriptionRef.current = null
      activeStreamTokenRef.current = null
      remoteStreamViewportSizeRef.current = null
      // Why: navigation recreates the screencast stream; keep the last frame during restart so panes don't flash the loading placeholder.
      if (!restart) {
        clearStreamFrame()
      }
      current?.unsubscribe()
      if (restart) {
        scheduleRemoteStreamRestart(token)
      }
    },
    [clearStreamFrame, isCurrentRemoteStreamToken, scheduleRemoteStreamRestart]
  )

  const startRemoteStream = useCallback(
    async (pageId: string): Promise<RemoteBrowserStreamSubscription | null> => {
      const target = runtimeTarget()
      if (!target) {
        return null
      }
      const operationToken = createRemoteOperationToken(pageId)
      if (!operationToken || !isCurrentRemoteOperationToken(operationToken)) {
        return null
      }
      const status = await callRuntimeRpc<RuntimeStatus>(target, 'status.get', undefined, {
        timeoutMs: 15_000
      })
      if (!status.capabilities?.includes('browser.screencast.v1')) {
        throw new Error('The selected runtime does not support remote browser streaming.')
      }
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return null
      }
      const viewportSize = await waitForRemoteViewportSize()
      remoteStreamViewportSizeRef.current = viewportSize
      const token: RemoteBrowserStreamToken = {
        tabId: browserTab.id,
        environmentId: target.environmentId,
        remotePageId: pageId,
        generation: streamGenerationRef.current + 1,
        operationGeneration: operationToken.generation
      }
      streamGenerationRef.current = token.generation
      activeStreamTokenRef.current = token
      try {
        const subscription = await window.api.runtimeEnvironments.subscribe(
          {
            selector: target.environmentId,
            method: 'browser.screencast',
            params: withBrowserPaneUiRuntimeRpcSource({
              worktree: runtimeWorktree,
              page: pageId,
              format: 'jpeg',
              quality: 70,
              maxWidth: 3840,
              maxHeight: 2160,
              viewportWidth: viewportSize?.width,
              viewportHeight: viewportSize?.height,
              deviceScaleFactor: getRemoteBrowserDeviceScaleFactor(),
              everyNthFrame: 2
            }),
            timeoutMs: 15_000
          },
          {
            onResponse: (response) => {
              if (!isCurrentRemoteStreamToken(token)) {
                return
              }
              if (response.ok === false) {
                if (isRemoteBrowserPageMissingCode(response.error.code)) {
                  closeMissingRemotePage(pageId)
                  return
                }
                setRemoteError(response.error.message)
                handleRemoteStreamClosed(token, false)
                return
              }
              const event = response.result as BrowserScreencastResult
              if (event.type === 'ready') {
                applyRemoteTabInfo(event.tab)
                void syncRemoteViewport(event.browserPageId).catch(() => {})
                setBusy(false)
              } else if (event.type === 'end') {
                handleRemoteStreamClosed(token, true)
              } else if (event.type === 'error') {
                setRemoteError(event.message)
                handleRemoteStreamClosed(token, false)
              }
            },
            onBinary: (bytes) => updateStreamFrame(token, bytes),
            onError: (error) => {
              if (!isCurrentRemoteStreamToken(token)) {
                return
              }
              if (isRemoteBrowserPageMissingError(error)) {
                closeMissingRemotePage(pageId)
                return
              }
              setRemoteError(error.message)
              setBusy(false)
            },
            onClose: () => {
              handleRemoteStreamClosed(token, true)
            }
          }
        )
        return { token, unsubscribe: subscription.unsubscribe }
      } catch (error) {
        if (isCurrentRemoteStreamToken(token)) {
          activeStreamTokenRef.current = null
        }
        throw error
      }
    },
    [
      applyRemoteTabInfo,
      browserTab.id,
      closeMissingRemotePage,
      createRemoteOperationToken,
      handleRemoteStreamClosed,
      isCurrentRemoteOperationToken,
      isCurrentRemoteStreamToken,
      runtimeTarget,
      syncRemoteViewport,
      updateStreamFrame,
      waitForRemoteViewportSize,
      runtimeWorktree
    ]
  )

  const restartRemoteStreamForViewport = useCallback(
    (pageId: string): void => {
      const current = streamSubscriptionRef.current
      const nextViewportSize = remoteViewportSizeRef.current
      if (
        !current ||
        current.token.remotePageId !== pageId ||
        !nextViewportSize ||
        areRemoteViewportSizesNear(remoteStreamViewportSizeRef.current, nextViewportSize) ||
        !isCurrentRemoteStreamToken(current.token)
      ) {
        return
      }

      // Why: the runtime stream validates frames against its start viewport, so restart media after resize or new-size frames get rejected.
      streamGenerationRef.current += 1
      activeStreamTokenRef.current = null
      streamSubscriptionRef.current = null
      remoteStreamViewportSizeRef.current = null
      if (streamRestartTimerRef.current !== null) {
        window.clearTimeout(streamRestartTimerRef.current)
        streamRestartTimerRef.current = null
      }
      setBusy(true)
      current.unsubscribe()
      void startRemoteStreamRef
        .current(pageId)
        .then((subscription) => {
          if (!subscription) {
            if (mountedRef.current && isActiveRef.current && remotePageIdRef.current === pageId) {
              setBusy(false)
            }
            return
          }
          if (!isCurrentRemoteStreamToken(subscription.token)) {
            subscription.unsubscribe()
            return
          }
          streamSubscriptionRef.current = subscription
        })
        .catch((error: unknown) => {
          if (!mountedRef.current || !isActiveRef.current || remotePageIdRef.current !== pageId) {
            return
          }
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setRemoteError(
            error instanceof Error ? error.message : 'Failed to resize remote browser stream.'
          )
          setBusy(false)
        })
    },
    [closeMissingRemotePage, isCurrentRemoteStreamToken]
  )

  useEffect(() => {
    startRemoteStreamRef.current = startRemoteStream
    restartRemoteStreamForViewportRef.current = restartRemoteStreamForViewport
  }, [restartRemoteStreamForViewport, startRemoteStream])

  useEffect(() => {
    if (!isActive) {
      return
    }
    let cancelled = false
    setBusy(true)
    setRemoteError(null)
    remoteOperationGenerationRef.current += 1
    streamGenerationRef.current += 1
    activeStreamTokenRef.current = null
    streamSubscriptionRef.current?.unsubscribe()
    streamSubscriptionRef.current = null
    if (streamRestartTimerRef.current !== null) {
      window.clearTimeout(streamRestartTimerRef.current)
      streamRestartTimerRef.current = null
    }
    const operationToken = createRemoteOperationToken()
    if (!operationToken) {
      setBusy(false)
      return
    }
    void ensureRemotePage(operationToken)
      .then(async (pageId) => {
        if (!pageId || cancelled || !isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        const pageToken = { ...operationToken, remotePageId: pageId }
        const tab = await fetchRemoteTabInfo(pageToken)
        if (tab && !cancelled && isCurrentRemoteOperationToken(pageToken)) {
          applyRemoteTabInfo(tab)
        }
        if (cancelled || !isCurrentRemoteOperationToken(pageToken)) {
          return
        }
        const subscription = await startRemoteStream(pageId)
        if (cancelled || !subscription) {
          subscription?.unsubscribe()
          return
        }
        if (!isCurrentRemoteStreamToken(subscription.token)) {
          subscription.unsubscribe()
          return
        }
        streamSubscriptionRef.current = subscription
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage()
            return
          }
          setRemoteError(error instanceof Error ? error.message : 'Failed to open remote browser.')
          setBusy(false)
        }
      })
    return () => {
      cancelled = true
      remoteOperationGenerationRef.current += 1
      streamGenerationRef.current += 1
      activeStreamTokenRef.current = null
      clearPendingRemoteWheel()
      streamSubscriptionRef.current?.unsubscribe()
      streamSubscriptionRef.current = null
      if (streamRestartTimerRef.current !== null) {
        window.clearTimeout(streamRestartTimerRef.current)
        streamRestartTimerRef.current = null
      }
    }
  }, [
    clearPendingRemoteWheel,
    createRemoteOperationToken,
    ensureRemotePage,
    fetchRemoteTabInfo,
    isActive,
    closeMissingRemotePage,
    isCurrentRemoteOperationToken,
    isCurrentRemoteStreamToken,
    applyRemoteTabInfo,
    startRemoteStream
  ])

  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFocusBrowserAddressBar(() => {
      addressBarInputRef.current?.focus()
      addressBarInputRef.current?.select()
    })
  }, [isActive])

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
  }, [browserTab.id, isActive])

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
      const pageId = await ensureRemotePage(operationToken)
      if (!pageId) {
        return
      }
      const pageToken = { ...operationToken, remotePageId: pageId }
      if (!isCurrentRemoteOperationToken(pageToken)) {
        return
      }
      setBusy(true)
      setRemoteError(null)
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
        setRemoteError(message)
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
          setBusy(false)
        }
      }
    },
    [
      applyRemoteTabInfo,
      browserTab.id,
      browserTab.url,
      createRemoteOperationToken,
      ensureRemotePage,
      closeMissingRemotePage,
      isCurrentRemoteOperationToken,
      onUpdatePageState,
      runtimeTarget,
      runtimeWorktree
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

  const handleRemotePointerDown = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    const image = imageRef.current
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right') {
      return
    }
    if (!target || !pageId || !image || !operationToken || !point || !button) {
      return
    }
    event.preventDefault()
    image.focus()
    setContextMenu(null)
    setRemoteError(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const params = { worktree: runtimeWorktree, page: pageId }
        await callRuntimeRpc(
          target,
          'browser.mouseMove',
          { ...params, x: point.x, y: point.y },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        await callRuntimeRpc(
          target,
          'browser.mouseDown',
          { ...params, button },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setRemoteError(error instanceof Error ? error.message : 'Remote mouse input failed.')
        }
      }
    })
  }

  const handleRemotePointerUp = (event: React.PointerEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    const point = getRemoteImagePoint(event)
    const button = getRemoteBrowserMouseButton(event.button)
    if (button === 'right') {
      return
    }
    if (!target || !pageId || !operationToken || !point || !button) {
      return
    }
    event.preventDefault()
    setRemoteError(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const params = { worktree: runtimeWorktree, page: pageId }
        await callRuntimeRpc(
          target,
          'browser.mouseMove',
          { ...params, x: point.x, y: point.y },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        await callRuntimeRpc(
          target,
          'browser.mouseUp',
          { ...params, button },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        scheduleRemoteTabInfoRefresh(operationToken, 250)
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setRemoteError(error instanceof Error ? error.message : 'Remote mouse input failed.')
        }
      }
    })
  }

  const handleRemoteContextMenu = (event: React.MouseEvent<HTMLImageElement>): void => {
    if (busy) {
      return
    }
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    const point = getRemoteImagePoint(event)
    if (!target || !pageId || !point) {
      return
    }
    event.preventDefault()
    imageRef.current?.focus()
    setRemoteError(null)
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      linkUrl: null,
      pageUrl: browserTab.url || 'about:blank',
      // Why: filled in below once the async eval reads the guest selection.
      selectionText: ''
    })
    enqueueRemoteInput(async () => {
      const operationToken = createRemoteOperationToken(pageId)
      if (!operationToken || !isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        const result = await callRuntimeRpc(
          target,
          'browser.eval',
          {
            worktree: runtimeWorktree,
            page: pageId,
            expression: buildRemoteContextMenuExpression(point.x, point.y)
          },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        const parsed = readRemoteContextMenuResult(result)
        if (parsed && mountedRef.current && isCurrentRemoteOperationToken(operationToken)) {
          setContextMenu((current) =>
            current
              ? {
                  ...current,
                  linkUrl: parsed.linkUrl,
                  pageUrl: redactKagiSessionToken(parsed.pageUrl),
                  selectionText: parsed.selectionText
                }
              : current
          )
        }
      } catch (error) {
        if (
          isCurrentRemoteOperationToken(operationToken) &&
          isRemoteBrowserPageMissingError(error)
        ) {
          closeMissingRemotePage(pageId)
        }
        // Keep the basic menu open even if element inspection is unavailable.
      }
    })
  }

  const handleRemoteScreenshotKeyDown = (event: React.KeyboardEvent<HTMLImageElement>): void => {
    if (isEditableKeyboardTarget(event.target)) {
      return
    }
    const target = runtimeTarget()
    const pageId = remotePageIdRef.current
    const operationToken = pageId ? createRemoteOperationToken(pageId) : null
    if (!target || !pageId || !operationToken) {
      return
    }
    const params = { worktree: runtimeWorktree, page: pageId }
    const key = getRemoteBrowserKeyboardShortcut(event) ?? getRemoteBrowserKeypressKey(event)
    if (!key) {
      return
    }
    event.preventDefault()
    setRemoteError(null)
    enqueueRemoteInput(async () => {
      if (!isCurrentRemoteOperationToken(operationToken)) {
        return
      }
      try {
        await callRuntimeRpc(
          target,
          'browser.keypress',
          { ...params, key },
          { timeoutMs: 15_000, suppressFeatureInteraction: true }
        )
        if (
          key === 'Enter' ||
          key === 'Meta+r' ||
          key === 'Meta+Shift+r' ||
          key === 'Control+r' ||
          key === 'Control+Shift+r'
        ) {
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        }
      } catch (error) {
        if (isCurrentRemoteOperationToken(operationToken)) {
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(pageId)
            return
          }
          setRemoteError(error instanceof Error ? error.message : 'Remote keyboard input failed.')
        }
      }
    })
  }

  const schedulePendingRemoteWheel = useCallback((): void => {
    if (remoteWheelFrameRef.current !== null || remoteWheelInFlightRef.current) {
      return
    }
    remoteWheelFrameRef.current = window.requestAnimationFrame(() => {
      remoteWheelFrameRef.current = null
      const pending = pendingRemoteWheelRef.current
      if (!pending || remoteWheelInFlightRef.current) {
        return
      }
      pendingRemoteWheelRef.current = null
      remoteWheelInFlightRef.current = true
      const { target, pageId, operationToken, point, dx, dy } = pending
      const params = { worktree: runtimeWorktree, page: pageId }
      void enqueueRemoteInput(async () => {
        if (!isCurrentRemoteOperationToken(operationToken)) {
          return
        }
        try {
          await callRuntimeRpc(
            target,
            'browser.mouseMove',
            { ...params, x: point.x, y: point.y },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          )
          await callRuntimeRpc(
            target,
            'browser.mouseWheel',
            {
              ...params,
              dx,
              dy
            },
            { timeoutMs: 15_000, suppressFeatureInteraction: true }
          )
          scheduleRemoteTabInfoRefresh(operationToken, 400)
        } catch (error) {
          if (isCurrentRemoteOperationToken(operationToken)) {
            if (isRemoteBrowserPageMissingError(error)) {
              closeMissingRemotePage(pageId)
              return
            }
            setRemoteError(error instanceof Error ? error.message : 'Remote scroll failed.')
          }
        }
      }).finally(() => {
        remoteWheelInFlightRef.current = false
        if (pendingRemoteWheelRef.current) {
          schedulePendingRemoteWheel()
        }
      })
    })
  }, [
    closeMissingRemotePage,
    enqueueRemoteInput,
    isCurrentRemoteOperationToken,
    scheduleRemoteTabInfoRefresh,
    runtimeWorktree
  ])

  const handleRemoteScreenshotWheel = useCallback(
    (event: WheelEvent): void => {
      if (busy) {
        event.preventDefault()
        return
      }
      const target = runtimeTarget()
      const pageId = remotePageIdRef.current
      const operationToken = pageId ? createRemoteOperationToken(pageId) : null
      const point = getRemoteImagePoint(event)
      if (!target || !pageId || !operationToken || !point) {
        return
      }
      event.preventDefault()
      setRemoteError(null)
      const deltaMultiplier =
        event.deltaMode === WHEEL_DELTA_LINE
          ? 16
          : event.deltaMode === WHEEL_DELTA_PAGE
            ? (remoteViewportRef.current?.clientHeight ?? 800)
            : 1
      const dx = Math.round(event.deltaX * deltaMultiplier)
      const dy = Math.round(event.deltaY * deltaMultiplier)
      if (dx === 0 && dy === 0) {
        return
      }
      const current = pendingRemoteWheelRef.current
      const sameTarget =
        current?.target.environmentId === target.environmentId &&
        current.pageId === pageId &&
        current.operationToken.generation === operationToken.generation
      pendingRemoteWheelRef.current = sameTarget
        ? {
            ...current,
            point,
            dx: current.dx + dx,
            dy: current.dy + dy
          }
        : {
            target,
            pageId,
            operationToken,
            point,
            dx,
            dy
          }
      schedulePendingRemoteWheel()
    },
    [
      busy,
      createRemoteOperationToken,
      getRemoteImagePoint,
      runtimeTarget,
      schedulePendingRemoteWheel
    ]
  )

  useEffect(() => {
    const image = imageRef.current
    if (!image || !frameUrl) {
      return
    }
    // Why: React binds wheel listeners passively in Chromium, so bind natively non-passive to preventDefault scroll.
    image.addEventListener('wheel', handleRemoteScreenshotWheel, { passive: false })
    return () => image.removeEventListener('wheel', handleRemoteScreenshotWheel)
  }, [frameUrl, handleRemoteScreenshotWheel])

  const remoteFrameStyle = useMemo(() => getRemoteBrowserFrameStyle(frameMetadata), [frameMetadata])
  const remoteFailureUrl = browserTab.loadError?.validatedUrl ?? browserTab.url
  const remoteFailureExternalUrl = resolveRemoteFailureExternalUrl(remoteFailureUrl)
  const showRemoteFailureOverlay =
    Boolean(browserTab.loadError) &&
    remoteFailureUrl !== 'about:blank' &&
    remoteFailureUrl !== ORCA_BROWSER_BLANK_URL

  // Why: markup snapshots the displayed screencast <img> (no injection), so it works on remote panes even though element-grab doesn't.
  const markup = useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const element = imageRef.current
      const container = remoteViewportRef.current
      if (!element || !container) {
        return null
      }
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: { kind: 'image', element },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, []),
    onDeliver: deliverMarkupToClipboard
  })

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col bg-background">
      {contextMenu
        ? createPortal(
            <>
              <div className="fixed inset-0 z-50" onPointerDown={() => setContextMenu(null)} />
              <div
                ref={contextMenuRef}
                role="menu"
                data-testid="remote-browser-context-menu"
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
                      {translate(
                        'auto.components.browser.pane.BrowserPane.b5b87d6cbb',
                        'Open Link In Orca Browser'
                      )}
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
                      {translate(
                        'auto.components.browser.pane.BrowserPane.8ce4f6b12e',
                        'Open Link In Default Browser'
                      )}
                    </button>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        void window.api.ui.writeClipboardText(contextMenu.linkUrl ?? '')
                        setContextMenu(null)
                      }}
                    >
                      {translate(
                        'auto.components.browser.pane.BrowserPane.efb0e8f7f3',
                        'Copy Link Address'
                      )}
                    </button>
                    <div className="my-1 h-px bg-border/70" />
                  </>
                ) : null}
                {contextMenu.selectionText.trim() ? (
                  <>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        void window.api.ui.writeClipboardText(contextMenu.selectionText)
                        setContextMenu(null)
                      }}
                    >
                      {translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy')}
                    </button>
                    <div className="my-1 h-px bg-border/70" />
                  </>
                ) : null}
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void runRemoteNavigation('browser.back')
                    setContextMenu(null)
                  }}
                >
                  {translate('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back')}
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void runRemoteNavigation('browser.forward')
                    setContextMenu(null)
                  }}
                >
                  {translate('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward')}
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void runRemoteNavigation('browser.reload')
                    setContextMenu(null)
                  }}
                >
                  {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
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
                  {translate(
                    'auto.components.browser.pane.BrowserPane.f7ab83f7ed',
                    'Open Page In Default Browser'
                  )}
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void window.api.ui.writeClipboardText(contextMenu.pageUrl)
                    setContextMenu(null)
                  }}
                >
                  {translate(
                    'auto.components.browser.pane.BrowserPane.1b179ab561',
                    'Copy Page URL'
                  )}
                </button>
              </div>
            </>,
            document.body
          )
        : null}
      <div
        className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
        data-contextual-tour-target="browser-toolbar"
      >
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
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.deb5293610',
                'Browser annotations unavailable in remote runtime'
              )}
              onClick={(event) => {
                event.preventDefault()
              }}
            >
              <MessageSquarePlus className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.browser.pane.BrowserPane.8b7e6d1f5a',
              'Browser annotations are only available in local browser tabs.'
            )}
          </TooltipContent>
        </Tooltip>
        <MarkupDrawButton
          onClick={() => (markup.isActive ? markup.cancel() : void markup.start())}
          disabled={!frameUrl}
          active={markup.isActive}
          surfaceActive={isActive}
          className="h-7 w-7"
        />
      </div>
      <div
        ref={remoteViewportRef}
        tabIndex={-1}
        className="relative min-h-0 flex-1 overflow-hidden bg-background"
      >
        {markup.isActive && markup.baseImage ? (
          <MarkupOverlay
            baseImage={markup.baseImage}
            busy={markup.state === 'composing'}
            onComplete={(input) => void markup.complete(input)}
            onCancel={markup.cancel}
          />
        ) : null}
        {frameUrl ? (
          <img
            ref={imageRef}
            src={frameUrl}
            alt=""
            tabIndex={0}
            style={remoteFrameStyle}
            className="absolute top-0 left-0 max-w-none cursor-default bg-white outline-none"
            onPointerDown={handleRemotePointerDown}
            onPointerUp={handleRemotePointerUp}
            onContextMenu={handleRemoteContextMenu}
            onKeyDown={handleRemoteScreenshotKeyDown}
            draggable={false}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
            <div className="flex max-w-sm flex-col items-center gap-2">
              {busy ? (
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              ) : (
                <Globe className="size-5 text-muted-foreground" />
              )}
              <div className="text-sm font-medium text-foreground">
                {busy
                  ? translate(
                      'auto.components.browser.pane.BrowserPane.b313a7275b',
                      'Opening remote browser'
                    )
                  : translate(
                      'auto.components.browser.pane.BrowserPane.572046436a',
                      'Remote browser'
                    )}
              </div>
              <div className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.browser.pane.BrowserPane.bbe8f15e83',
                  'This pane is rendered from the active runtime server.'
                )}
              </div>
            </div>
          </div>
        )}
        {showRemoteFailureOverlay && browserTab.loadError ? (
          <BrowserLoadFailureOverlay
            loadError={browserTab.loadError}
            externalUrl={remoteFailureExternalUrl}
            currentUrl={toDisplayUrl(remoteFailureUrl)}
            httpsRecoveryUrl={toHttpsRecoveryUrl(remoteFailureUrl)}
            onRetry={() => void runRemoteNavigation('browser.reload')}
            onTryHttps={(url) => void runRemoteNavigation('browser.goto', url)}
            onCopy={(url) => void window.api.ui.writeClipboardText(url)}
            onOpenExternal={(url) => void window.api.shell.openUrl(url)}
            certificateFailure={remoteCertificateTrustSupported ? certificateFailure : null}
            expectedBrowserPageId={
              remotePageHandle?.environmentId === activeRuntimeEnvironmentId
                ? remotePageHandle.remotePageId
                : null
            }
            onProceedCertificate={async (challengeId) => {
              const target = runtimeTarget()
              if (
                !target ||
                remotePageHandle?.environmentId !== target.environmentId ||
                remotePageHandle.remotePageId !== certificateFailure?.browserPageId
              ) {
                return { ok: false, reason: 'missing' }
              }
              return callRuntimeRpc<BrowserCertificateProceedResult>(
                target,
                'browser.certificate.proceed',
                {
                  worktree: runtimeWorktree,
                  page: remotePageHandle.remotePageId,
                  challengeId
                },
                { timeoutMs: 15_000, suppressFeatureInteraction: true }
              )
            }}
          />
        ) : null}
        {remoteError ? (
          <div className="absolute bottom-4 left-1/2 max-w-md -translate-x-1/2 rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
            {remoteError}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function preventAgentSendTargetOutsideDismiss(event: CustomEvent<{ originalEvent: Event }>) {
  const target = event.detail.originalEvent.target
  if (!(target instanceof Element)) {
    return
  }
  if (
    target.closest(
      '[data-agent-send-target="eligible"], [data-agent-send-target="disabled"], [data-agent-send-target="sending"]'
    )
  ) {
    event.preventDefault()
  }
}

function BrowserPagePane({
  browserTab,
  workspaceId,
  worktreeId,
  sessionProfileId,
  sessionPartition,
  isActive,
  isAutomationVisible,
  isMobileDriven,
  inputLocked,
  onUpdatePageState,
  onSetUrl
}: {
  browserTab: BrowserPageState
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  sessionPartition: string | null
  isActive: boolean
  isAutomationVisible: boolean
  isMobileDriven: boolean
  inputLocked: boolean
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: (tabId: string, url: string) => void
}): React.JSX.Element {
  const isPaintable = isBrowserPagePanePaintable({
    isActive,
    isAutomationVisible,
    isMobileDriven
  })
  const pageViewport = ensureBrowserPageViewport(browserTab.id, workspaceId)
  const containerRef = useRef<HTMLDivElement | null>(null)
  containerRef.current = pageViewport?.container ?? null
  const chromeHeaderRef = useRef<HTMLDivElement | null>(null)
  const grabToastTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const annotationCopyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const browserZoomFeedbackTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    return () => {
      clearTimeout(grabToastTimerRef.current)
      clearTimeout(annotationCopyTimerRef.current)
      clearTimeout(browserZoomFeedbackTimerRef.current)
    }
  }, [])
  const [slotViewportReady, setSlotViewportReady] = useState(
    () => getBrowserOverlaySlotViewport(workspaceId) !== null
  )
  useLayoutEffect(() => {
    if (getBrowserOverlaySlotViewport(workspaceId)) {
      setSlotViewportReady(true)
      return
    }
    return subscribeBrowserOverlaySlotViewport(workspaceId, () => {
      setSlotViewportReady(true)
    })
  }, [workspaceId])
  const addressBarInputRef = useRef<HTMLInputElement | null>(null)
  const dismissAddressBarSuggestionsRef = useRef<(() => void) | null>(null)
  const webviewRef = useRef<Electron.WebviewTag | null>(null)
  const browserTabIdRef = useRef(browserTab.id)
  browserTabIdRef.current = browserTab.id
  const inputLockedRef = useRef(inputLocked)
  inputLockedRef.current = inputLocked
  const navigateBrowserHistoryRef = useRef<(direction: 'back' | 'forward') => void>(() => {})
  navigateBrowserHistoryRef.current = (direction: 'back' | 'forward'): void => {
    // Why: Logitech Options+ side-button remaps arrive as these chords on macOS; route through the same nav path as the toolbar.
    if (direction === 'back') {
      webviewRef.current?.goBack()
    } else {
      webviewRef.current?.goForward()
    }
  }
  const handleInternalFileDragOverRef = useRef<(event: DragEvent<HTMLDivElement>) => void>(() => {})
  const handleInternalFileDropRef = useRef<(event: DragEvent<HTMLDivElement>) => void>(() => {})
  const keybindings = useAppStore((state) => state.keybindings)
  const browserDefaultZoomLevel = useAppStore(
    (state) => state.browserDefaultZoomLevel ?? DEFAULT_BROWSER_PAGE_ZOOM_LEVEL
  )
  const setBrowserDefaultZoomLevel = useAppStore((state) => state.setBrowserDefaultZoomLevel)
  const normalizedBrowserDefaultZoomLevel = normalizeBrowserPageZoomLevel(browserDefaultZoomLevel)
  const browserDefaultZoomPercent = browserPageZoomLevelToPercent(normalizedBrowserDefaultZoomLevel)
  const browserDefaultZoomLevelRef = useRef(normalizedBrowserDefaultZoomLevel)
  browserDefaultZoomLevelRef.current = normalizedBrowserDefaultZoomLevel
  const grabElementShortcut = useShortcutLabel('browser.grabElement')
  const faviconUrlRef = useRef<string | null>(browserTab.faviconUrl)
  const initialBrowserUrlRef = useRef(browserTab.url)
  const browserTabUrlRef = useRef(browserTab.url)
  const activeLoadFailureRef = useRef<BrowserLoadError | null>(browserTab.loadError)
  // Why: CDP viewport emulation doesn't survive renderer process swaps, so reapply the preset from this ref on every dom-ready.
  const viewportPresetIdRef = useRef(browserTab.viewportPresetId ?? null)
  viewportPresetIdRef.current = browserTab.viewportPresetId ?? null
  const trackNextLoadingEventRef = useRef(false)
  // Most-recent observed webview URL; URL sync checks it to avoid force-navigating to an intermediate redirect (which would loop the redirect chain).
  const lastKnownWebviewUrlRef = useRef<string | null>(null)
  const onUpdatePageStateRef = useRef(onUpdatePageState)
  const onSetUrlRef = useRef(onSetUrl)
  const addBrowserHistoryEntry = useAppStore((s) => s.addBrowserHistoryEntry)
  const addBrowserHistoryEntryRef = useRef(addBrowserHistoryEntry)
  const [addressBarValue, setAddressBarValue] = useState(browserTab.url)
  const addressBarValueRef = useRef(browserTab.url)
  const [resourceNotice, setResourceNotice] = useState<string | null>(null)
  const [downloadStates, setDownloadStates] = useState<BrowserDownloadState[]>([])
  const downloadStatesRef = useRef<BrowserDownloadState[]>([])
  const [browserZoomPercent, setBrowserZoomPercent] = useState(browserDefaultZoomPercent)
  const [browserZoomFeedbackVisible, setBrowserZoomFeedbackVisible] = useState(false)
  const [contextMenu, setContextMenu] = useState<{
    x: number
    y: number
    linkUrl: string | null
    pageUrl: string
    selectionText: string
  } | null>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const [findOpen, setFindOpen] = useState(false)
  const grab = useGrabMode(browserTab.id)

  const markup = useMarkupMode({
    getCaptureContext: useCallback((): MarkupCaptureContext | null => {
      const webview = webviewRef.current
      const container = containerRef.current
      if (!webview || !container) {
        return null
      }
      const rect = container.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) {
        return null
      }
      return {
        source: { kind: 'webview', webview },
        cssWidth: rect.width,
        cssHeight: rect.height,
        outputScale: window.devicePixelRatio || 1
      }
    }, []),
    onDeliver: deliverMarkupToClipboard
  })
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
  const annotationViewportBridgeTokenRef = useRef(createBrowserUuid().replaceAll('-', ''))
  const browserAnnotations = useAppStore(
    (s) => s.browserAnnotationsByPageId[browserTab.id] ?? EMPTY_BROWSER_ANNOTATIONS
  )
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const activeGroupId = useAppStore((s) => s.activeGroupIdByWorktree[worktreeId])
  const browserAnnotationsRef = useRef(browserAnnotations)
  browserAnnotationsRef.current = browserAnnotations
  const [browserAnnotationTrayOpen, setBrowserAnnotationTrayOpen] = useState(true)
  const [browserAnnotationsCopied, setBrowserAnnotationsCopied] = useState(false)
  const browserAnnotationsPrompt = useMemo(
    () => formatBrowserAnnotationsAsMarkdown(browserAnnotations),
    [browserAnnotations]
  )
  const openAgentSendPopoverTargetMode = useAppStore((s) => s.openAgentSendPopoverTargetMode)
  const closeAgentSendPopoverTargetMode = useAppStore((s) => s.closeAgentSendPopoverTargetMode)
  const activeAgentSendTargetModeId = useAppStore((s) => s.agentSendPopoverTargetMode?.id ?? null)
  const annotationBannerSendModeId = `browser-annotations:${browserTab.id}:banner`
  const annotationTraySendModeId = `browser-annotations:${browserTab.id}:tray`
  const [annotationBannerSendOpen, setAnnotationBannerSendOpen] = useState(false)
  const [annotationTraySendOpen, setAnnotationTraySendOpen] = useState(false)
  const addBrowserPageAnnotation = useAppStore((s) => s.addBrowserPageAnnotation)
  const deleteBrowserPageAnnotation = useAppStore((s) => s.deleteBrowserPageAnnotation)
  const clearBrowserPageAnnotations = useAppStore((s) => s.clearBrowserPageAnnotations)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const clearBrowserPageAnnotationsRef = useRef(clearBrowserPageAnnotations)
  clearBrowserPageAnnotationsRef.current = clearBrowserPageAnnotations
  const createBrowserTab = useAppStore((s) => s.createBrowserTab)
  const consumeAddressBarFocusRequest = useAppStore((s) => s.consumeAddressBarFocusRequest)
  const browserSessionProfiles = useAppStore((s) => s.browserSessionProfiles)
  const activeOrcaProfileId = useAppStore((s) => s.activeOrcaProfileId)
  const fallbackBrowserPartition = activeOrcaProfileId
    ? getOrcaProfileBrowserDefaultPartition(activeOrcaProfileId)
    : null
  const defaultSessionProfile = browserSessionProfiles.find((p) => p.id === 'default') ?? null
  const sessionProfile = sessionProfileId
    ? (browserSessionProfiles.find((p) => p.id === sessionProfileId) ?? null)
    : defaultSessionProfile
  const webviewPartition =
    sessionPartition ??
    sessionProfile?.partition ??
    defaultSessionProfile?.partition ??
    fallbackBrowserPartition ??
    ORCA_BROWSER_PARTITION
  const browserSessionImportState = useAppStore((s) => s.browserSessionImportState)
  const clearBrowserSessionImportState = useAppStore((s) => s.clearBrowserSessionImportState)
  const showBrowserZoomFeedback = useCallback((level: number): void => {
    setBrowserZoomPercent(browserPageZoomLevelToPercent(level))
    setBrowserZoomFeedbackVisible(true)
    clearTimeout(browserZoomFeedbackTimerRef.current)
    browserZoomFeedbackTimerRef.current = setTimeout(() => {
      setBrowserZoomFeedbackVisible(false)
    }, BROWSER_PAGE_ZOOM_FEEDBACK_MS)
  }, [])

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

  // Inline toast near the grabbed element (below, or above near the viewport bottom) so it doesn't occlude the selection.
  const [grabToast, setGrabToast] = useState<{
    message: string
    type: 'success' | 'error'
    x: number
    y: number
    below: boolean
    payload: BrowserGrabPayload | null
  } | null>(null)

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
    // Why: only rearm while 'confirming'; if a C/S shortcut already rearmed (state 'armed'), skip to avoid a double-rearm race.
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

  // Why: the same in-guest picker powers two flows — Cmd/Ctrl+C copies, the toolbar action creates a pending annotation.
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
      recordFeatureInteraction('browser-grab')
      showGrabToast('Copied', 'success', grab.payload)
    }
  }, [
    grab.state,
    grab.payload,
    grab.contextMenu,
    grabIntent,
    recordFeatureInteraction,
    showGrabToast
  ])

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
    // Why: don't clobber an in-progress address-bar query when an async URL update lands; syncing resumes once the input blurs.
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
    downloadStatesRef.current = downloadStates
  }, [downloadStates])

  useEffect(() => {
    setResourceNotice(null)
    setDownloadStates([])
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
      // Why: convert OS screen cursor coords to renderer CSS pixels — immune to guest/renderer coordinate-space mismatches from zoom/DPI.
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
        pageUrl: event.pageUrl,
        selectionText: event.selectionText ?? ''
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

  // Why: ancestor CSS (transform/backdrop-filter) can shift position:fixed even via a body Portal, so measure/correct before paint; also flip on viewport overflow.
  useLayoutEffect(() => {
    const el = contextMenuRef.current
    if (!el || !contextMenu) {
      return
    }
    el.style.left = `${contextMenu.x}px`
    el.style.top = `${contextMenu.y}px`
    const rect = el.getBoundingClientRect()

    // Why: CSS containing blocks can shift "fixed" elements; capture the offset between requested and actual position.
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
      setDownloadStates((current) => {
        const nextEntry: BrowserDownloadState = {
          browserPageId: event.browserPageId,
          downloadId: event.downloadId,
          origin: event.origin,
          filename: event.filename,
          totalBytes: event.totalBytes,
          mimeType: event.mimeType,
          receivedBytes: 0,
          status: 'downloading',
          savePath: event.savePath,
          error: null,
          progressState: null,
          completedAt: null
        }
        const existingIndex = current.findIndex(
          (download) => download.downloadId === event.downloadId
        )
        if (existingIndex === -1) {
          return [nextEntry, ...current]
        }
        const next = [...current]
        next[existingIndex] = { ...next[existingIndex], ...nextEntry }
        return next
      })
      setResourceNotice(null)
    })
  }, [browserTab.id])

  useEffect(() => {
    return window.api.browser.onDownloadProgress((event: BrowserDownloadProgressEvent) => {
      setDownloadStates((current) =>
        current.map((download) =>
          download.downloadId === event.downloadId
            ? {
                ...download,
                receivedBytes: event.receivedBytes,
                totalBytes: event.totalBytes,
                progressState: event.state
              }
            : download
        )
      )
    })
  }, [])

  useEffect(() => {
    return window.api.browser.onDownloadFinished((event: BrowserDownloadFinishedEvent) => {
      if (event.browserPageId && event.browserPageId !== browserTab.id) {
        return
      }
      const current = downloadStatesRef.current
      if (!current.some((download) => download.downloadId === event.downloadId)) {
        return
      }
      setDownloadStates((current) =>
        current.map((download) =>
          download.downloadId === event.downloadId
            ? {
                ...download,
                status: event.status,
                savePath: event.savePath,
                error: event.error,
                completedAt: Date.now()
              }
            : download
        )
      )
    })
  }, [browserTab.id])

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
    if (!isActive) {
      return
    }
    if (!consumeAddressBarFocusRequest(browserTab.id)) {
      return
    }
    keepAddressBarFocusRef.current = true
    // Why: terminal activation re-grabs focus a frame later; retry a few frames to win the race, but stay one-shot so revisiting the tab doesn't steal focus.
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
  }, [browserTab.id, consumeAddressBarFocusRequest, focusAddressBarNow, isActive])

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
    // Why: focus can be queued before the pane mounts; persisting outside React lets it be claimed on mount instead of racing an event.
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
        // Why: palette-triggered address-bar focus must survive the same follow-up load events as the blank-tab path.
        keepAddressBarFocusRef.current = true
        focusAddressBarNow()
        return
      }
      keepAddressBarFocusRef.current = false
      focusWebviewNow()
    }
    // Why: an already-active page never remounts, so listen for the event to consume the durable focus request immediately.
    window.addEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
    return () =>
      window.removeEventListener(ORCA_BROWSER_FOCUS_REQUEST_EVENT, handleBrowserFocusRequest)
  }, [browserTab.id, focusAddressBarNow, focusWebviewNow, isActive])

  // Cmd/Ctrl+F — find in page (renderer path: focus on browser chrome)
  // Why: unlike bare C/S grab shortcuts, Cmd+F should always open find even from the address bar (matches Chrome/Safari).
  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.find', e, shortcutPlatform, keybindings)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      setFindOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings])

  // Cmd/Ctrl+F — find in page (IPC path: focus inside webview guest)
  // Why: a focused guest is a separate Chromium process, so main forwards the chord back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onFindInBrowserPage(() => {
      setFindOpen(true)
    })
  }, [isActive])

  // Browser history shortcuts (renderer path: focus on browser chrome)
  // Why: macOS can't deliver Logitech side-buttons to Electron; Logi Options+ remaps them to history chords, handled here when chrome is focused.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const direction = keybindingMatchesAction('browser.back', e, shortcutPlatform, keybindings)
        ? 'back'
        : keybindingMatchesAction('browser.forward', e, shortcutPlatform, keybindings)
          ? 'forward'
          : null
      if (direction === null) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      navigateBrowserHistoryRef.current(direction)
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings])

  // Browser history shortcuts (IPC path: focus inside webview guest)
  // Why: a focused webview is a separate WebContents, so main forwards the chords back here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    return window.api.ui.onBrowserHistoryNavigate((direction) => {
      navigateBrowserHistoryRef.current(direction)
    })
  }, [isActive])

  // Close find bar when tab is deactivated
  useEffect(() => {
    if (!isActive) {
      setFindOpen(false)
    }
  }, [isActive])

  // Cmd/Ctrl+R — reload (renderer path: focus on browser chrome, not in guest)
  // Why: guest shortcut forwarding never fires when focus is on browser chrome, so handle the chord directly here.
  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      const isHardReload = keybindingMatchesAction(
        'browser.hardReload',
        e,
        shortcutPlatform,
        keybindings
      )
      const isReload = keybindingMatchesAction('browser.reload', e, shortcutPlatform, keybindings)
      if (!isHardReload && !isReload) {
        return
      }
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      if (isHardReload) {
        webviewRef.current?.reloadIgnoringCache()
      } else {
        webviewRef.current?.reload()
      }
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isActive, keybindings])

  // Cmd/Ctrl+R — reload (IPC path: focus inside webview guest)
  // Why: a focused guest is a separate Chromium process, so main forwards the chord back here.
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
    const applyActivePageZoom = (direction: BrowserPageZoomDirection): void => {
      if (!isActiveRef.current) {
        return
      }
      const nextLevel = applyBrowserPageZoom(webviewRef.current, direction)
      if (nextLevel !== null) {
        setBrowserDefaultZoomLevel(nextLevel)
        showBrowserZoomFeedback(nextLevel)
      }
    }
    const removeGuestListener = window.api.ui.onZoomBrowserPage(applyActivePageZoom)
    const removeLocalListener = addBrowserPageZoomEventListener((detail) => {
      if (detail.browserPageId !== browserTabIdRef.current) {
        return
      }
      applyActivePageZoom(detail.direction)
    })
    return () => {
      removeGuestListener()
      removeLocalListener()
    }
  }, [isActive, setBrowserDefaultZoomLevel, showBrowserZoomFeedback])

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
          // Why: attach can transiently report isLoading() with no real navigation; syncing it would flash the loading dot on tab switches.
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward()
        })
      } catch {
        // Why: these getters only exist after the guest fully attaches; ignore the transient failure during attach.
      }
    },
    [browserTab.id]
  )

  const syncBrowserAnnotationViewportBridge = useCallback((): void => {
    const pendingAnnotationPayload = pendingAnnotationPayloadRef.current
    // Why: existing badges render in-guest for smooth scroll; only the pending dialog needs viewport messages.
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
        // The viewport bridge is visual-only; stale markers beat breaking the pane on a destroyed guest.
      })
  }, [browserTab.id])

  // Why: browserTab.url excluded from deps (changes every navigation → would destroy/recreate the webview); URL logic reads browserTabUrlRef.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- see comment above
  useEffect(() => {
    let container = ensureBrowserPageViewport(browserTab.id, workspaceId)?.container ?? null
    if (!container) {
      return
    }

    const ensuredWebview = ensureBrowserPageWebview({
      browserTabId: browserTab.id,
      container,
      inputLocked: inputLockedRef.current,
      webviewPartition,
      resolveContainer: () =>
        ensureBrowserPageViewport(browserTab.id, workspaceId)?.container ?? null
    })
    if (!ensuredWebview) {
      return
    }
    container = ensuredWebview.container
    const webview = ensuredWebview.webview
    const needsInitialNavigation = ensuredWebview.created
    let needsInitialDefaultZoom = ensuredWebview.created

    if (!ensuredWebview.created) {
      // pointerEvents already applied inside ensureBrowserPageWebview for the reused-webview path.
      syncNavigationState(webview)
      // Why: seed from the store URL (getURL() can throw during attach) so URL sync won't force-navigate an already-correct webview.
      lastKnownWebviewUrlRef.current =
        normalizeBrowserNavigationUrl(browserTabUrlRef.current) ?? null
    }

    webviewRef.current = webview

    // Why: un-park the shell before webview.src is assigned or the guest navigates while hidden and stays blank (the visibility layout effect doesn't re-run on first appear).
    applyBrowserPageViewportLayout(browserTab.id, { paintable: isPaintable, active: isActive })

    const onContainerDragOver = (event: globalThis.DragEvent): void => {
      handleInternalFileDragOverRef.current(event as unknown as DragEvent<HTMLDivElement>)
    }
    const onContainerDrop = (event: globalThis.DragEvent): void => {
      handleInternalFileDropRef.current(event as unknown as DragEvent<HTMLDivElement>)
    }
    container.addEventListener('dragover', onContainerDragOver)
    container.addEventListener('drop', onContainerDrop)

    const dismissAddressBarSuggestions = (): void => {
      dismissAddressBarSuggestionsRef.current?.()
    }

    let registrationInFlight: { webContentsId: number; promise: Promise<boolean> } | null = null
    const registerGuest = (): Promise<boolean> => {
      const webContentsId = webview.getWebContentsId()
      if (registeredWebContentsIds.get(browserTab.id) === webContentsId) {
        return Promise.resolve(true)
      }
      if (registrationInFlight?.webContentsId === webContentsId) {
        return registrationInFlight.promise
      }
      const promise = window.api.browser
        .registerGuest({
          browserPageId: browserTab.id,
          workspaceId,
          worktreeId,
          sessionProfileId,
          webContentsId
        })
        .then((registered) => {
          if (registered) {
            registeredWebContentsIds.set(browserTab.id, webContentsId)
          }
          return registered
        })
        // Why: normalize IPC rejection to false so the dom-ready fallback can retry attach-policy races.
        .catch(() => false)
        .finally(() => {
          if (registrationInFlight?.promise === promise) {
            registrationInFlight = null
          }
        })
      registrationInFlight = { webContentsId, promise }
      return promise
    }

    const handleDidAttach = (): void => {
      // Why: register at attach since cert failures can precede dom-ready; the dom-ready path stays an idempotent fallback.
      void registerGuest().finally(() => syncBrowserAnnotationViewportBridge())
    }

    const handleDomReady = (): void => {
      const queuedAnnotationViewportBridgeSync =
        registeredWebContentsIds.get(browserTab.id) !== webview.getWebContentsId()
      if (queuedAnnotationViewportBridgeSync) {
        void registerGuest().finally(() => syncBrowserAnnotationViewportBridge())
      }
      syncNavigationState(webview)
      if (keepAddressBarFocusRef.current) {
        focusAddressBarNow()
      }
      if (!queuedAnnotationViewportBridgeSync) {
        syncBrowserAnnotationViewportBridge()
      }
      if (needsInitialDefaultZoom) {
        const appliedLevel = setBrowserPageZoomLevel(webview, browserDefaultZoomLevelRef.current)
        if (appliedLevel !== null) {
          setBrowserZoomPercent(browserPageZoomLevelToPercent(appliedLevel))
        }
        needsInitialDefaultZoom = false
      }
      // Why: CDP viewport overrides are scoped to the debugger session and don't survive cross-origin nav, so reapply (idempotently) on dom-ready.
      const presetId = viewportPresetIdRef.current
      const preset = getBrowserViewportPreset(presetId)
      // Why: reapply even null so CDP matches store state; setDeviceMetricsOverride persists across same-origin nav and would leave a stale viewport.
      void window.api.browser.setViewportOverride({
        browserPageId: browserTab.id,
        override: preset ? browserViewportPresetToOverride(preset) : null
      })
    }

    const handleDidStartLoading = (): void => {
      // Why: a reload replaces the document without changing the URL, invalidating captured element rects like a navigation does.
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
          description: translate(
            'auto.components.browser.pane.BrowserPane.e48569ac6d',
            'This site could not be reached.'
          ),
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
          // Why: some failures still emit did-stop-loading on the original URL; keep loadError so the known-failed load isn't cleared to a blank surface.
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
      // Why: don't overwrite in-progress typing (see the browserTab.url sync effect above).
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
        // Why: Chromium reports redirect/cancel races as ERR_ABORTED (-3) even when the replacement navigation succeeds; ignore to avoid a false failure.
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

    webview.addEventListener('did-attach', handleDidAttach)
    webview.addEventListener('dom-ready', handleDomReady)
    webview.addEventListener('focus', dismissAddressBarSuggestions)
    webview.addEventListener('did-start-loading', handleDidStartLoading)
    webview.addEventListener('did-stop-loading', handleDidStopLoading)
    // Why: close find only on full 'did-navigate', not the shared handler, which also fires on SPA in-page hash/pushState changes.
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
      // Why: set src only after listeners attach so a fast localhost failure isn't missed; only non-blank tabs show the loading indicator.
      const initialUrl =
        normalizeBrowserNavigationUrl(initialBrowserUrlRef.current) ?? ORCA_BROWSER_BLANK_URL
      trackNextLoadingEventRef.current = initialUrl !== ORCA_BROWSER_BLANK_URL
      lastKnownWebviewUrlRef.current = initialUrl
      webview.src = initialUrl
    }

    return () => {
      webview.removeEventListener('did-attach', handleDidAttach)
      webview.removeEventListener('dom-ready', handleDomReady)
      webview.removeEventListener('focus', dismissAddressBarSuggestions)
      webview.removeEventListener('did-start-loading', handleDidStartLoading)
      webview.removeEventListener('did-stop-loading', handleDidStopLoading)
      webview.removeEventListener('did-navigate', handleDidNavigate)
      webview.removeEventListener('did-navigate', handleFindCloseOnNavigate)
      webview.removeEventListener('did-navigate-in-page', handleDidNavigate)
      webview.removeEventListener('page-title-updated', handleTitleUpdate)
      webview.removeEventListener('page-favicon-updated', handleFaviconUpdate)
      webview.removeEventListener('did-fail-load', handleFailLoad)
      webview.removeEventListener('console-message', handleAnnotationViewportMessage)
      container.removeEventListener('dragover', onContainerDragOver)
      container.removeEventListener('drop', onContainerDrop)

      if (webviewRef.current === webview) {
        webviewRef.current = null
      }

      // Why: park the viewport on chrome unmount (worktree switch) to keep the guest alive; destroy only on explicit close.
      moveFocusToRendererBeforeWebviewDetach(webview)
      parkBrowserPageViewport(browserTab.id)
    }
    // Why: wire listeners once per tab identity. browserTab.url is excluded (re-running would detach/reattach and cancel navigations; callbacks use refs).
    // webviewPartition IS included: Electron can't change a webview's partition after creation, so a profile switch must recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    browserTab.id,
    workspaceId,
    slotViewportReady,
    webviewPartition,
    worktreeId,
    createBrowserTab,
    focusAddressBarNow,
    focusWebviewNow,
    syncNavigationState,
    syncBrowserAnnotationViewportBridge
  ])

  useLayoutEffect(() => {
    applyBrowserPageViewportLayout(browserTab.id, { paintable: isPaintable, active: isActive })
    const syncChromeInset = (): void => {
      const header = chromeHeaderRef.current
      if (!header) {
        return
      }
      syncBrowserPageChromeInset(browserTab.id, header.offsetHeight)
    }
    syncChromeInset()
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(syncChromeInset)
    const header = chromeHeaderRef.current
    if (header) {
      resizeObserver?.observe(header)
    }
    return () => {
      resizeObserver?.disconnect()
    }
    // Why: re-run once slotViewportReady flips so visibility and chrome-inset land on a real viewport (first render no-ops).
  }, [browserTab.id, isActive, isPaintable, slotViewportReady])

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
    // Why: navigation events set both the store URL and this ref; a match means the change came from navigation, so skip to avoid a redirect infinite loop.
    if (lastKnownWebviewUrlRef.current === normalizedUrl) {
      return
    }
    let liveUrl: string | null = null
    try {
      liveUrl = webview.getURL() || null
    } catch {
      // Why: a newly attached guest can reject getURL(); skip so a transient error isn't misread as a mismatch and force-navigated.
      return
    }
    const normalizedLiveUrl = liveUrl ? (normalizeBrowserNavigationUrl(liveUrl) ?? liveUrl) : null
    const declaredSrc = webview.getAttribute('src')
    if (
      normalizedLiveUrl !== normalizedUrl &&
      webview.src !== normalizedUrl &&
      declaredSrc !== normalizedUrl
    ) {
      // Why: browserTab.url changes are Orca-driven navigations; gate did-start-loading so only real navigations show loading UI.
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
    if (!shouldPollChromiumErrorPage({ isActive, loading: browserTab.loading })) {
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
            description: translate(
              'auto.components.browser.pane.BrowserPane.e48569ac6d',
              'This site could not be reached.'
            ),
            validatedUrl: redactKagiSessionToken(attemptedUrl)
          }
        })
      } catch {
        // Why: ignore transient getURL() errors from a mid-attach guest; this poll is only a fallback.
      }
    }

    // Why: some Electron builds paint chrome-error pages without a did-fail-load event; poll only while the active tab loads as a fallback.
    detectChromiumErrorPage()
    const intervalId = window.setInterval(detectChromiumErrorPage, 250)
    return () => window.clearInterval(intervalId)
  }, [browserTab.id, browserTab.loading, isActive])

  const startGrabIntent = useCallback(
    (nextIntent: GrabIntent): void => {
      recordFeatureInteraction('browser-grab')
      if (nextIntent === 'annotate') {
        recordFeatureInteraction('browser-annotations')
      }
      setGrabIntent(nextIntent)
      recordFeatureInteraction(nextIntent === 'annotate' ? 'browser-annotations' : 'browser-grab')
      if (nextIntent === 'copy') {
        setPendingAnnotationPayload(null)
      } else {
        setBrowserAnnotationTrayOpen(true)
      }
      if (grab.state === 'idle' || grab.state === 'error' || grabIntent === nextIntent) {
        grab.toggle()
      }
    },
    [grab, grabIntent, recordFeatureInteraction]
  )

  // Why: Cmd+C is repurposed as the grab-mode gesture; native text copy in the guest is handled by Chromium and never reaches here.
  useEffect(() => {
    // Why: gate on isActive so only the active pane's global keydown listener toggles grab mode.
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Why: don't intercept in editable targets so native Cmd+C still copies in inputs/contentEditable.
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      // Why: don't start the in-guest picker behind an open markup overlay (matches the disabled toolbar buttons).
      if (
        !markup.isActive &&
        keybindingMatchesAction('browser.grabElement', e, shortcutPlatform, keybindings)
      ) {
        e.preventDefault()
        startGrabIntent('copy')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isActive, keybindings, markup.isActive, startGrabIntent])

  useEffect(() => {
    if (!isActive) {
      return
    }
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!keybindingMatchesAction('browser.focusAddressBar', e, shortcutPlatform, keybindings)) {
        return
      }
      // Why: capture Cmd/Ctrl+L before the workspace or an embedded editor can claim the same chord.
      e.preventDefault()
      e.stopPropagation()
      focusAddressBarNow()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [focusAddressBarNow, isActive, keybindings])

  // Why: a focused guest gets Cmd/Ctrl+C inside Chromium; main forwards it back only when the page wouldn't use it for native copy.
  useEffect(() => {
    return window.api.browser.onGrabModeToggle((tabId) => {
      if (tabId === browserTab.id) {
        startGrabIntent('copy')
      }
    })
  }, [browserTab.id, startGrabIntent])

  // C / S copy the hovered element without clicking: extract via IPC while armed/awaiting, else use the captured payload.
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
          recordFeatureInteraction('browser-grab')
          showGrabToast('Copied', 'success', payload)
        } else {
          const dataUrl = payload.screenshot?.dataUrl
          if (dataUrl?.startsWith('data:image/png;base64,')) {
            void window.api.ui.writeClipboardImage(dataUrl)
            recordFeatureInteraction('browser-grab')
            showGrabToast('Screenshotted', 'success', payload)
          } else {
            showGrabToast('No screenshot available', 'error', payload)
          }
        }
      }

      if (grab.state === 'confirming') {
        // Why: right-click (contextMenu) skips the left-click auto-copy, so C must still work here.
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
    [grab, grabIntent, recordFeatureInteraction, showGrabToast]
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

  // Why: Radix fires onOpenChange(false) before onSelect, so this flag lets onOpenChange skip the rearm that would clear the payload first.
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
    recordFeatureInteraction('browser-grab')
    showGrabToast('Copied', 'success', payload)
    grab.rearm()
  }, [grab, recordFeatureInteraction, showGrabToast])

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
    recordFeatureInteraction('browser-grab')
    showGrabToast('Screenshotted', 'success', payload)
    grab.rearm()
  }, [grab, recordFeatureInteraction, showGrabToast])

  const handleAddBrowserAnnotation = useCallback(
    (comment: string, intent: BrowserAnnotationIntent): void => {
      const payload = pendingAnnotationPayload
      if (!payload) {
        return
      }
      addBrowserPageAnnotation({
        id: createBrowserAnnotationId(),
        browserPageId: browserTab.id,
        comment,
        intent,
        priority: DEFAULT_BROWSER_ANNOTATION_PRIORITY,
        createdAt: new Date().toISOString(),
        payload: createBrowserAnnotationPayload(payload)
      })
      recordFeatureInteraction('browser-annotations')
      setPendingAnnotationPayload(null)
      setBrowserAnnotationTrayOpen(true)
      recordFeatureInteraction('browser-annotations')
      showGrabToast('Annotation added', 'success', payload)
      grab.rearm()
    },
    [
      addBrowserPageAnnotation,
      browserTab.id,
      grab,
      pendingAnnotationPayload,
      recordFeatureInteraction,
      showGrabToast
    ]
  )

  const handleCancelPendingBrowserAnnotation = useCallback((): void => {
    setPendingAnnotationPayload(null)
    if (grabIntent === 'annotate' && grab.state === 'confirming') {
      grab.rearm()
    }
  }, [grab, grabIntent])

  const handleCopyBrowserAnnotations = useCallback((): void => {
    if (!browserAnnotationsPrompt) {
      return
    }
    void window.api.ui.writeClipboardText(browserAnnotationsPrompt)
    recordFeatureInteraction('browser-annotations')
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(true)
    annotationCopyTimerRef.current = setTimeout(() => setBrowserAnnotationsCopied(false), 1400)
  }, [browserAnnotationsPrompt, recordFeatureInteraction])

  const handleAnnotationBannerSendOpenChange = useCallback(
    (open: boolean): void => {
      setAnnotationBannerSendOpen(open)
      if (open) {
        openAgentSendPopoverTargetMode({
          id: annotationBannerSendModeId,
          worktreeId,
          source: 'browser-annotations',
          prompt: browserAnnotationsPrompt,
          label: translate(
            'auto.components.browser.pane.BrowserPane.27d863542c',
            'Browser annotations'
          ),
          launchSource: 'notes_send'
        })
      } else {
        closeAgentSendPopoverTargetMode(annotationBannerSendModeId)
      }
    },
    [
      annotationBannerSendModeId,
      browserAnnotationsPrompt,
      closeAgentSendPopoverTargetMode,
      openAgentSendPopoverTargetMode,
      worktreeId
    ]
  )

  const handleAnnotationTraySendOpenChange = useCallback(
    (open: boolean): void => {
      setAnnotationTraySendOpen(open)
      if (open) {
        openAgentSendPopoverTargetMode({
          id: annotationTraySendModeId,
          worktreeId,
          source: 'browser-annotations',
          prompt: browserAnnotationsPrompt,
          label: translate(
            'auto.components.browser.pane.BrowserPane.27d863542c',
            'Browser annotations'
          ),
          launchSource: 'notes_send'
        })
      } else {
        closeAgentSendPopoverTargetMode(annotationTraySendModeId)
      }
    },
    [
      annotationTraySendModeId,
      browserAnnotationsPrompt,
      closeAgentSendPopoverTargetMode,
      openAgentSendPopoverTargetMode,
      worktreeId
    ]
  )

  useEffect(() => {
    if (annotationBannerSendOpen && activeAgentSendTargetModeId !== annotationBannerSendModeId) {
      setAnnotationBannerSendOpen(false)
    }
    if (annotationTraySendOpen && activeAgentSendTargetModeId !== annotationTraySendModeId) {
      setAnnotationTraySendOpen(false)
    }
  }, [
    activeAgentSendTargetModeId,
    annotationBannerSendModeId,
    annotationBannerSendOpen,
    annotationTraySendModeId,
    annotationTraySendOpen
  ])

  useEffect(
    () => () => {
      closeAgentSendPopoverTargetMode(annotationBannerSendModeId)
      closeAgentSendPopoverTargetMode(annotationTraySendModeId)
    },
    [annotationBannerSendModeId, annotationTraySendModeId, closeAgentSendPopoverTargetMode]
  )

  const handleBrowserAnnotationsSentToAgent = useCallback((): void => {
    recordFeatureInteraction('browser-annotations-sent-to-agent')
  }, [recordFeatureInteraction])

  const handleClearBrowserAnnotations = useCallback((): void => {
    if (browserAnnotationsRef.current.length === 0) {
      return
    }
    clearTimeout(annotationCopyTimerRef.current)
    setBrowserAnnotationsCopied(false)
    recordFeatureInteraction('browser-annotations')
    clearBrowserPageAnnotations(browserTab.id)
  }, [browserTab.id, clearBrowserPageAnnotations, recordFeatureInteraction])

  const handleDeleteBrowserAnnotation = useCallback(
    (annotationId: string): void => {
      deleteBrowserPageAnnotation(browserTab.id, annotationId)
      recordFeatureInteraction('browser-annotations')
    },
    [browserTab.id, deleteBrowserPageAnnotation, recordFeatureInteraction]
  )

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
          description: translate(
            'auto.components.browser.pane.BrowserPane.87eb75f7d2',
            'Enter a valid http(s) or localhost URL.'
          ),
          // Why: redact a possible Kagi session token before persisting into loadError.
          validatedUrl: redactKagiSessionToken(addressBarValue.trim()) || 'about:blank'
        }
      })
      return
    }
    navigateToUrl(nextUrl)
  }

  // Why: a blank tab reads as 'about:blank' or the resolved data: URL, so match both to keep the "New Browser Tab" overlay visible.
  const isBlankTab = browserTab.url === 'about:blank' || browserTab.url === ORCA_BROWSER_BLANK_URL
  const externalUrl = getOpenableExternalUrl(webviewRef.current, browserTab.url)
  const currentBrowserUrl = getCurrentBrowserUrl(webviewRef.current, browserTab.url)
  const failedNavigationUrl = browserTab.loadError?.validatedUrl ?? currentBrowserUrl
  const failureExternalUrl = normalizeExternalBrowserUrl(failedNavigationUrl)
  const showFailureOverlay = Boolean(browserTab.loadError) && !isBlankTab
  const visibleDownloads = (() => {
    const active = downloadStates.filter((download) => download.status === 'downloading')
    const recent = downloadStates
      .filter((download) => download.status !== 'downloading')
      .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
      .slice(0, 3)
    return [...active, ...recent]
  })()
  const browserZoomIndicatorState = getBrowserPageZoomIndicatorState({
    feedbackVisible: browserZoomFeedbackVisible,
    isDefaultZoom: browserZoomPercent === browserDefaultZoomPercent
  })

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: Electron webviews keep receiving native input under a React overlay unless their own hit testing is disabled.
    webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
  }, [inputLocked])

  useEffect(() => {
    const webview = webviewRef.current
    if (!webview) {
      return
    }
    // Why: some Electron builds keep painting a hidden guest layer, so drop it from layout (display:none) instead of just hiding it.
    webview.style.display = showFailureOverlay ? 'none' : 'flex'
  }, [showFailureOverlay])

  const handleInternalFileDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
      return
    }
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
  }, [])
  handleInternalFileDragOverRef.current = handleInternalFileDragOver

  const handleInternalFileDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME)) {
        return
      }
      event.preventDefault()
      event.stopPropagation()

      // Why: a browser opens one URL, so reject multi-path drags rather than silently opening the lead file.
      const dragPaths = readWorkspaceFileDragPaths(event.dataTransfer, { maxPaths: 1 })
      if (dragPaths.status === 'rejected') {
        setResourceNotice(getWorkspaceFileDragRejectionMessage(dragPaths.reason))
        return
      }
      const filePath = dragPaths.paths[0]
      if (!filePath) {
        return
      }

      const target = getWorkspaceFileBrowserOpenTarget({ filePath, worktreeId })
      if (target.status === 'unsupported') {
        setResourceNotice(target.message)
        return
      }

      const webview = webviewRef.current
      const rect = webview?.getBoundingClientRect()
      if (!webview || !rect) {
        setResourceNotice('Browser page is not ready for file drops.')
        return
      }
      const pageX = event.clientX - rect.left
      const pageY = event.clientY - rect.top
      if (pageX < 0 || pageY < 0 || pageX > rect.width || pageY > rect.height) {
        setResourceNotice('Drop files over the browser page, not the toolbar.')
        return
      }

      navigateToUrl(target.url)
    },
    [navigateToUrl, worktreeId]
  )
  handleInternalFileDropRef.current = handleInternalFileDrop

  const dismissBrowserDownload = useCallback((downloadId: string) => {
    setDownloadStates((current) => current.filter((download) => download.downloadId !== downloadId))
  }, [])

  const handleOpenDownloadedFile = useCallback(async (download: BrowserDownloadState) => {
    if (!download.savePath) {
      setResourceNotice(
        translate(
          'auto.components.browser.pane.BrowserPane.9f6f2e8c19',
          'The downloaded file path is unavailable.'
        )
      )
      return
    }
    const opened = await window.api.shell.openFilePath(download.savePath)
    if (!opened) {
      setResourceNotice(
        translate(
          'auto.components.browser.pane.BrowserPane.0c79b7634d',
          'Could not open the downloaded file. It may have been moved or deleted.'
        )
      )
    }
  }, [])

  const handleShowDownloadedFile = useCallback(async (download: BrowserDownloadState) => {
    if (!download.savePath) {
      setResourceNotice(
        translate(
          'auto.components.browser.pane.BrowserPane.9f6f2e8c19',
          'The downloaded file path is unavailable.'
        )
      )
      return
    }
    const result = await window.api.shell.openInFileManager(download.savePath)
    if (!result.ok) {
      setResourceNotice(
        translate(
          'auto.components.browser.pane.BrowserPane.397d9dc923',
          'Could not show the downloaded file. It may have been moved or deleted.'
        )
      )
    }
  }, [])

  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-1 flex-col',
        isActive
          ? 'pointer-events-none z-10'
          : isPaintable
            ? 'pointer-events-none z-0 opacity-0'
            : 'pointer-events-none hidden'
      )}
      // Why: hidden panes stay paintable (automation/mobile) but must not stay keyboard-focusable.
      inert={!isActive}
      aria-hidden={!isActive}
    >
      {/* IPC-driven context menu in a Portal so position:fixed escapes ancestor transform/backdrop-filter containing blocks. */}
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
                      {translate(
                        'auto.components.browser.pane.BrowserPane.b5b87d6cbb',
                        'Open Link In Orca Browser'
                      )}
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
                      {translate(
                        'auto.components.browser.pane.BrowserPane.8ce4f6b12e',
                        'Open Link In Default Browser'
                      )}
                    </button>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        void window.api.ui.writeClipboardText(contextMenu.linkUrl ?? '')
                        setContextMenu(null)
                      }}
                    >
                      {translate(
                        'auto.components.browser.pane.BrowserPane.efb0e8f7f3',
                        'Copy Link Address'
                      )}
                    </button>
                    <div className="my-1 h-px bg-border/70" />
                  </>
                ) : null}
                {contextMenu.selectionText.trim() ? (
                  <>
                    <button
                      role="menuitem"
                      className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                      onClick={() => {
                        void window.api.ui.writeClipboardText(contextMenu.selectionText)
                        setContextMenu(null)
                      }}
                    >
                      {translate('auto.components.browser.pane.BrowserPane.2a4c4b8e1f', 'Copy')}
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
                  {translate('auto.components.browser.pane.BrowserPane.40edfa75cb', 'Back')}
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
                  {translate('auto.components.browser.pane.BrowserPane.250a9b3e42', 'Forward')}
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    webviewRef.current?.reload()
                    setContextMenu(null)
                  }}
                >
                  {translate('auto.components.browser.pane.BrowserPane.0e080d820e', 'Reload')}
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
                  {translate(
                    'auto.components.browser.pane.BrowserPane.f7ab83f7ed',
                    'Open Page In Default Browser'
                  )}
                </button>
                <button
                  role="menuitem"
                  className="relative flex w-full cursor-default items-center gap-2 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium outline-none select-none hover:bg-black/8 dark:hover:bg-white/14"
                  onClick={() => {
                    void window.api.ui.writeClipboardText(contextMenu.pageUrl)
                    setContextMenu(null)
                  }}
                >
                  {translate(
                    'auto.components.browser.pane.BrowserPane.1b179ab561',
                    'Copy Page URL'
                  )}
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
                  {translate('auto.components.browser.pane.BrowserPane.a8f37f70c3', 'Inspect Page')}
                </button>
              </div>
            </>,
            document.body
          )
        : null}

      <div ref={chromeHeaderRef} className="pointer-events-auto shrink-0">
        <div
          className="relative z-10 flex items-center gap-2 border-b border-border/70 bg-background/95 px-3 py-1.5"
          data-contextual-tour-target="browser-toolbar"
        >
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
            dismissSuggestionsRef={dismissAddressBarSuggestionsRef}
          />

          <BrowserImportHintButton profileId={sessionProfileId} />

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
                  disabled={isBlankTab || markup.isActive}
                  aria-label={translate(
                    'auto.components.browser.pane.BrowserPane.fdfc7fe0ef',
                    'Grab page element'
                  )}
                  data-contextual-tour-target="browser-grab-control"
                >
                  <Crosshair className="size-4" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}>
              {translate(
                'auto.components.browser.pane.BrowserPane.acbe79fd01',
                'Grab page element ({{value0}})',
                { value0: grabElementShortcut }
              )}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              {/* Why: disabled <button> drops hover events, so wrap in a span so the tooltip trigger still fires. */}
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
                  disabled={isBlankTab || markup.isActive}
                  aria-label={translate(
                    'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                    'Annotate page element'
                  )}
                  data-contextual-tour-target="browser-annotation-control"
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
              {translate(
                'auto.components.browser.pane.BrowserPane.fc9be38f6f',
                'Annotate page element'
              )}
            </TooltipContent>
          </Tooltip>

          <MarkupDrawButton
            onClick={() => (markup.isActive ? markup.cancel() : void markup.start())}
            disabled={isBlankTab || grab.state !== 'idle'}
            active={markup.isActive}
            surfaceActive={isActive}
          />

          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => void window.api.browser.openDevTools({ browserPageId: browserTab.id })}
            title={translate(
              'auto.components.browser.pane.BrowserPane.ec75d0c412',
              'Open browser devtools'
            )}
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
            title={translate(
              'auto.components.browser.pane.BrowserPane.0f41bf80c7',
              'Open in default browser'
            )}
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
            isActive={isActive}
          />
        </div>
        {visibleDownloads.length > 0 ? (
          <div className="border-b border-border/60 bg-background px-3 py-1.5">
            <div className="scrollbar-sleek flex max-h-36 flex-col gap-1 overflow-y-auto">
              {visibleDownloads.map((download) => {
                const progressLabel = formatBrowserDownloadProgress(download)
                const statusLabel =
                  download.status === 'downloading'
                    ? download.progressState === 'interrupted'
                      ? translate(
                          'auto.components.browser.pane.BrowserPane.39c04fed61',
                          'Downloading paused'
                        )
                      : (progressLabel ??
                        translate(
                          'auto.components.browser.pane.BrowserPane.759f32af29',
                          'Downloading'
                        ))
                    : download.status === 'completed'
                      ? translate(
                          'auto.components.browser.pane.BrowserPane.5c3d530a68',
                          'Downloaded'
                        )
                      : download.status === 'canceled'
                        ? translate(
                            'auto.components.browser.pane.BrowserPane.4bb7424d6b',
                            'Canceled'
                          )
                        : (download.error ??
                          translate(
                            'auto.components.browser.pane.BrowserPane.6e776f9ef9',
                            'Download failed'
                          ))
                return (
                  <div
                    key={download.downloadId}
                    className="flex min-h-8 items-center gap-2 text-xs text-foreground"
                  >
                    {download.status === 'completed' ? (
                      <CircleCheck className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : download.status === 'failed' ? (
                      <OctagonX className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Download className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{download.filename}</div>
                      <div className="truncate text-muted-foreground">
                        {download.status === 'downloading'
                          ? translate(
                              'auto.components.browser.pane.BrowserPane.4300f38145',
                              'Downloading from {{value0}}{{value1}}',
                              {
                                value0: download.origin,
                                value1: statusLabel ? ` • ${statusLabel}` : ''
                              }
                            )
                          : statusLabel}
                      </div>
                    </div>
                    {download.status === 'downloading' ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        className="h-6 shrink-0"
                        onClick={() => {
                          void window.api.browser.cancelDownload({
                            downloadId: download.downloadId
                          })
                        }}
                      >
                        {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
                      </Button>
                    ) : download.status === 'completed' ? (
                      <>
                        <Button
                          size="xs"
                          variant="outline"
                          className="h-6 shrink-0 gap-1"
                          onClick={() => {
                            void handleOpenDownloadedFile(download)
                          }}
                        >
                          <ExternalLink className="size-3" />
                          {translate('auto.components.browser.pane.BrowserPane.756bfc25c9', 'Open')}
                        </Button>
                        <Button
                          size="xs"
                          variant="ghost"
                          className="h-6 shrink-0 gap-1"
                          onClick={() => {
                            void handleShowDownloadedFile(download)
                          }}
                        >
                          <FolderOpen className="size-3" />
                          {translate('auto.components.browser.pane.BrowserPane.09a9489aa5', 'Show')}
                        </Button>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="h-6 w-6 shrink-0"
                          onClick={() => dismissBrowserDownload(download.downloadId)}
                          aria-label={translate(
                            'auto.components.browser.pane.BrowserPane.2fdca7df09',
                            'Dismiss'
                          )}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        className="h-6 w-6 shrink-0"
                        onClick={() => dismissBrowserDownload(download.downloadId)}
                        aria-label={translate(
                          'auto.components.browser.pane.BrowserPane.2fdca7df09',
                          'Dismiss'
                        )}
                      >
                        <X className="size-3.5" />
                      </Button>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        ) : null}
        {resourceNotice ? (
          <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-muted-foreground">
            <span>{resourceNotice}</span>
            <button
              type="button"
              onClick={() => setResourceNotice(null)}
              className="shrink-0 text-muted-foreground/60 hover:text-foreground"
              aria-label={translate(
                'auto.components.browser.pane.BrowserPane.2fdca7df09',
                'Dismiss'
              )}
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
                ? translate(
                    'auto.components.browser.pane.BrowserPane.4328a0a062',
                    'Grab failed: {{value0}}',
                    { value0: grab.error ?? 'Unknown error' }
                  )
                : grabIntent === 'annotate'
                  ? pendingAnnotationPayload
                    ? translate(
                        'auto.components.browser.pane.BrowserPane.b733a91bd9',
                        'Add feedback for the selected element.'
                      )
                    : browserAnnotations.length === 1
                      ? translate(
                          'auto.components.browser.pane.BrowserPane.074f0ed10b',
                          '{{value0}} annotation ready. Select another element or copy all feedback.',
                          { value0: browserAnnotations.length }
                        )
                      : browserAnnotations.length > 0
                        ? translate(
                            'auto.components.browser.pane.BrowserPane.a2164a6e5a',
                            '{{value0}} annotations ready. Select another element or copy all feedback.',
                            { value0: browserAnnotations.length }
                          )
                        : translate(
                            'auto.components.browser.pane.BrowserPane.777b5bc4ec',
                            'Click an element to add feedback for the agent.'
                          )
                  : grab.state === 'confirming'
                    ? translate(
                        'auto.components.browser.pane.BrowserPane.e852e20cea',
                        'Copied — press S to screenshot, or select another element'
                      )
                    : translate(
                        'auto.components.browser.pane.BrowserPane.168350ae6a',
                        'Click or hover an element, then press C to copy or S to screenshot.'
                      )}
            </span>
            {grabIntent === 'annotate' && browserAnnotations.length > 0 ? (
              <>
                <DropdownMenu
                  modal={false}
                  open={annotationBannerSendOpen}
                  onOpenChange={handleAnnotationBannerSendOpenChange}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <DropdownMenuTrigger asChild>
                        <Button size="xs" variant="outline" className="h-6 gap-1.5">
                          <Send className="size-3" />
                          {translate('auto.components.browser.pane.BrowserPane.ac39b9366b', 'Send')}
                        </Button>
                      </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={6}>
                      {translate(
                        'auto.components.browser.pane.BrowserPane.95af781091',
                        'Send feedback to an agent'
                      )}
                    </TooltipContent>
                  </Tooltip>
                  <DropdownMenuContent
                    align="end"
                    className="min-w-[180px]"
                    onInteractOutside={preventAgentSendTargetOutsideDismiss}
                    onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
                  >
                    <BrowserAnnotationSendMenuContent
                      worktreeId={worktreeId}
                      groupId={activeGroupId ?? worktreeId}
                      prompt={browserAnnotationsPrompt}
                      onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                    />
                  </DropdownMenuContent>
                </DropdownMenu>
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
                  {browserAnnotationsCopied
                    ? translate('auto.components.browser.pane.BrowserPane.6f4ab3592b', 'Copied')
                    : translate('auto.components.browser.pane.BrowserPane.499b31b84e', 'Copy All')}
                </Button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      className="h-6 w-6 text-muted-foreground hover:text-foreground"
                      onClick={handleClearBrowserAnnotations}
                      aria-label={translate(
                        'auto.components.browser.pane.BrowserPane.734e4343ec',
                        'Clear browser annotations'
                      )}
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={6}>
                    {translate(
                      'auto.components.browser.pane.BrowserPane.11c5084aa2',
                      'Clear annotations'
                    )}
                  </TooltipContent>
                </Tooltip>
              </>
            ) : null}
            <button
              className="ml-auto shrink-0 rounded px-2 py-0.5 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setPendingAnnotationPayload(null)
                grab.cancel()
              }}
            >
              {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
            </button>
          </div>
        ) : null}
      </div>
      {pageViewport?.container
        ? createPortal(
            <>
              {markup.isActive && markup.baseImage ? (
                <MarkupOverlay
                  baseImage={markup.baseImage}
                  busy={markup.state === 'composing'}
                  onComplete={(input) => void markup.complete(input)}
                  onCancel={markup.cancel}
                />
              ) : null}
              <div
                role="status"
                aria-live="polite"
                aria-hidden={browserZoomIndicatorState.ariaHidden}
                className={cn(
                  'pointer-events-none absolute top-3 right-3 z-30 rounded-md border border-border bg-popover/95 px-2.5 py-1 text-xs font-medium text-popover-foreground shadow-xs transition-opacity duration-300 ease-out',
                  browserZoomIndicatorState.opacityClassName
                )}
              >
                {browserZoomPercent}%
              </div>
              <BrowserFind
                isOpen={findOpen}
                onClose={() => setFindOpen(false)}
                webviewRef={webviewRef}
              />
              {showFailureOverlay && browserTab.loadError ? (
                <BrowserLoadFailureOverlay
                  loadError={browserTab.loadError}
                  externalUrl={failureExternalUrl}
                  currentUrl={toDisplayUrl(failedNavigationUrl)}
                  httpsRecoveryUrl={toHttpsRecoveryUrl(failedNavigationUrl)}
                  onRetry={() => {
                    const webview = webviewRef.current
                    if (!webview) {
                      return
                    }
                    onUpdatePageStateRef.current(browserTab.id, { loading: true })
                    retryBrowserTabLoad(webview, browserTab, onUpdatePageStateRef.current)
                  }}
                  onTryHttps={navigateToUrl}
                  onCopy={(url) => {
                    void window.api.ui.writeClipboardText(url)
                    setResourceNotice(
                      translate(
                        'browser.loadFailure.addressCopied',
                        'Copied the current page address.'
                      )
                    )
                  }}
                  onOpenExternal={(url) => void window.api.shell.openUrl(url)}
                  certificateFailure={certificateFailure}
                  expectedBrowserPageId={browserTab.id}
                  onProceedCertificate={(challengeId) =>
                    window.api.browser.proceedCertificate({
                      browserPageId: browserTab.id,
                      challengeId
                    })
                  }
                />
              ) : null}
              {isBlankTab ? (
                <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-[radial-gradient(circle_at_center,rgba(255,255,255,0.02),transparent_58%)] px-6">
                  <div className="flex flex-col items-center px-8 py-8 text-center opacity-70">
                    <div className="mb-4 rounded-full border border-border/70 bg-muted/30 p-3">
                      <Globe className="size-5 text-muted-foreground" />
                    </div>
                    <div className="text-center">
                      <p className="text-base font-semibold text-foreground/85">
                        {translate(
                          'auto.components.browser.pane.BrowserPane.366bf5d62c',
                          'New Tab'
                        )}
                      </p>
                      <p className="mt-2 text-sm text-muted-foreground">
                        {translate(
                          'auto.components.browser.pane.BrowserPane.f796c774a4',
                          'Type a URL above to start browsing.'
                        )}
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
                      {browserAnnotations.length === 1
                        ? translate(
                            'auto.components.browser.pane.BrowserPane.ea6af700da',
                            '{{value0}} annotation',
                            { value0: browserAnnotations.length }
                          )
                        : translate(
                            'auto.components.browser.pane.BrowserPane.c13693fe27',
                            '{{value0}} annotations',
                            { value0: browserAnnotations.length }
                          )}
                    </div>
                    <DropdownMenu
                      modal={false}
                      open={annotationTraySendOpen}
                      onOpenChange={handleAnnotationTraySendOpenChange}
                    >
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <DropdownMenuTrigger asChild>
                            <Button size="xs" variant="outline" className="gap-1.5">
                              <Send className="size-3" />
                              {translate(
                                'auto.components.browser.pane.BrowserPane.ac39b9366b',
                                'Send'
                              )}
                            </Button>
                          </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" sideOffset={6}>
                          {translate(
                            'auto.components.browser.pane.BrowserPane.95af781091',
                            'Send feedback to an agent'
                          )}
                        </TooltipContent>
                      </Tooltip>
                      <DropdownMenuContent
                        align="end"
                        className="min-w-[180px]"
                        onInteractOutside={preventAgentSendTargetOutsideDismiss}
                        onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
                      >
                        <BrowserAnnotationSendMenuContent
                          worktreeId={worktreeId}
                          groupId={activeGroupId ?? worktreeId}
                          prompt={browserAnnotationsPrompt}
                          onPromptDelivered={handleBrowserAnnotationsSentToAgent}
                        />
                      </DropdownMenuContent>
                    </DropdownMenu>
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
                      {browserAnnotationsCopied
                        ? translate('auto.components.browser.pane.BrowserPane.6f4ab3592b', 'Copied')
                        : translate('auto.components.browser.pane.BrowserPane.d51ef37351', 'Copy')}
                    </Button>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="text-muted-foreground hover:text-foreground"
                          onClick={handleClearBrowserAnnotations}
                          aria-label={translate(
                            'auto.components.browser.pane.BrowserPane.734e4343ec',
                            'Clear browser annotations'
                          )}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={6}>
                        {translate(
                          'auto.components.browser.pane.BrowserPane.11c5084aa2',
                          'Clear annotations'
                        )}
                      </TooltipContent>
                    </Tooltip>
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
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            <span>{annotation.intent}</span>
                          </div>
                        </div>
                        <Button
                          size="icon-xs"
                          variant="ghost"
                          className="can-hover:opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                          onClick={() => handleDeleteBrowserAnnotation(annotation.id)}
                          aria-label={translate(
                            'auto.components.browser.pane.BrowserPane.f2d0c22d67',
                            'Delete annotation {{value0}}',
                            { value0: index + 1 }
                          )}
                        >
                          <Trash2 className="size-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {/* Right-click context dropdown, positioned at the grabbed element's center. */}
              <DropdownMenu
                open={grab.state === 'confirming' && grab.contextMenu && grabIntent === 'copy'}
                onOpenChange={(open) => {
                  if (!open && grab.state === 'confirming') {
                    // Why: skip rearm if a menu action already handled it — see grabMenuActionTakenRef.
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
                    {translate(
                      'auto.components.browser.pane.BrowserPane.c2ef0359b9',
                      'Copy Contents'
                    )}
                    <DropdownMenuShortcut>C</DropdownMenuShortcut>
                  </DropdownMenuItem>
                  {grab.payload?.screenshot?.dataUrl?.startsWith('data:image/png;base64,') ? (
                    <DropdownMenuItem onSelect={handleGrabCopyScreenshot}>
                      <Image className="size-3.5" />
                      {translate(
                        'auto.components.browser.pane.BrowserPane.1ded0d3168',
                        'Copy Screenshot'
                      )}
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
                    {translate('auto.components.browser.pane.BrowserPane.fa6ea61de3', 'Cancel')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Inline toast bubble; flips above the element when near the viewport bottom so it doesn't occlude it. */}
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
                      grabToast.type === 'success'
                        ? 'bg-white text-gray-900'
                        : 'bg-white text-red-600'
                    }`}
                  >
                    {grabToast.type === 'success' ? (
                      <CircleCheck className="size-4 fill-blue-600 text-white" />
                    ) : (
                      <OctagonX className="size-4 text-red-500" />
                    )}
                    <span className="text-sm font-semibold">{grabToast.message}</span>
                    {grabToast.payload?.screenshot?.dataUrl?.startsWith(
                      'data:image/png;base64,'
                    ) ? (
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
                                  prev
                                    ? {
                                        ...prev,
                                        message: translate(
                                          'auto.components.browser.pane.BrowserPane.f30d2d35a7',
                                          'Screenshotted'
                                        )
                                      }
                                    : null
                                )
                              }
                            }}
                          >
                            <Image className="size-3.5" />
                            {translate(
                              'auto.components.browser.pane.BrowserPane.1ded0d3168',
                              'Copy Screenshot'
                            )}
                            <DropdownMenuShortcut>S</DropdownMenuShortcut>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </>,
            pageViewport.container
          )
        : null}
    </div>
  )
}
