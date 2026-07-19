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

// Why: priority remains in the persisted annotation shape for backwards
// compatibility, but the annotation UI no longer exposes urgency choices.
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
  // Why: inactive Electron webviews must stay mounted in their original DOM
  // parent. Parking them by unmounting/reparenting loses form text and SPA
  // state on normal tab switches.
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

  // Why: a remote runtime that predates browser.certificate-trust.v1 cannot
  // honor a proceed request, so the "Proceed Anyway (Unsafe)" affordance stays
  // hidden until the connected runtime positively advertises support (design
  // doc: older runtimes never show an enabled proceed action).
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
      // Why: a runtime-side tab close is the remote equivalent of closing the
      // visible browser tab; don't leave a dead pane behind with a not-found RPC.
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
        // Why: the streamed bitmap can include the host compositor surface,
        // while CDP input wants the guest page's CSS viewport coordinates.
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
    // Why: StrictMode (and any real remount) runs mount→cleanup→mount. The
    // cleanup sets mountedRef false; without re-arming it on mount, every
    // subsequent operation token reads as stale (isCurrentRemoteOperationToken
    // gates on mountedRef) and the pane wedges on "Opening remote browser".
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
    // Why: only reset the visible frame/wheel when the pane's identity changes.
    // The stream/operation generations are owned solely by the streaming effect
    // below — bumping them here too races that effect (e.g. under StrictMode's
    // mount→cleanup→mount), leaving its captured token permanently one behind so
    // the pane wedges on "Opening remote browser" while frames are available.
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
      // Why: remote browser tabs outlive React components on the daemon. Close
      // only when the local page is gone or its owning runtime environment is.
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
      // Why: browser navigation can close and recreate the screencast stream.
      // Keep the last frame visible during restart so remote browser panes do
      // not flash back to the generic loading placeholder on every navigation.
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

      // Why: the runtime stream validates frames against the viewport it was
      // started with. After a pane resize, restart media so new-size frames are
      // accepted instead of leaving the renderer on the last old-size bitmap.
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
          // Why: validatedUrl crosses process/persistence boundaries, so redact a
          // Kagi session token the same way the main-process failure path does.
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
  // Why: remote browser panes have no local webview ref, so history shortcuts
  // must route through the runtime RPC methods rather than desktop WebContents.
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
    // Why: React delegates wheel listeners passively in Chromium, so native
    // non-passive binding is required to prevent page scroll and console noise.
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

  // Why: markup works on remote panes by snapshotting the already-displayed
  // screencast <img> — no in-page injection needed, so it is enabled here even
  // though element-grab annotations are not.
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
    // Why: Logitech Options+ side-button remaps on macOS arrive as these
    // keyboard shortcuts. This local pane owns the webview ref, so route the
    // remap through the same navigation path as the toolbar buttons.
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

  // Browser history shortcuts (renderer path: focus on browser chrome)
  // Why: macOS cannot deliver Logitech side-button navigation to Electron, but
  // Logi Options+ can remap those buttons to standard browser history chords.
  // Handle the chords here when focus is on the toolbar or address bar.
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
  // Why: a focused webview is a separate WebContents. Main forwards the same
  // remapped history chords back here so page focus and toolbar focus behave
  // identically.
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
  // Why: when focus is inside the renderer chrome (address bar, toolbar buttons)
  // rather than the webview guest, the guest shortcut forwarding in main never
  // fires. Handle the chord directly here so reload works regardless of where
  // focus sits within the browser pane.
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
          // Why: webview attach can transiently report isLoading() even
          // when no user-visible navigation happened. If we sync that into the
          // tab model on every activation, switching tabs flashes the blue
          // loading dot and makes hidden tabs look like they are reloading.
          // Only explicit navigation/load events should drive Orca's loading UI.
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward()
        })
      } catch {
        // Why: Electron only exposes these getters after the guest fully
        // attaches. Ignoring the transient failure avoids crashing Orca while
        // the webview guest becomes ready.
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
  // creation, event wiring, and teardown. browserTab.url is
  // intentionally excluded — it changes on every navigation, and including it
  // would destroy and recreate the webview on every page load. URL-dependent
  // logic inside the effect reads from browserTabUrlRef instead.
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
      // pointerEvents is already applied inside ensureBrowserPageWebview for the
      // reused-webview path, so it isn't repeated here.
      syncNavigationState(webview)
      // Why: seed the ref with the store URL so the URL sync effect does not
      // force-navigate an already-mounted webview that is on the right page.
      // getURL() can throw briefly during attach, so use the store URL from the
      // last navigation event.
      lastKnownWebviewUrlRef.current =
        normalizeBrowserNavigationUrl(browserTabUrlRef.current) ?? null
    }

    webviewRef.current = webview

    // Why: the viewport shell is created display:none and the lifecycle cleanup
    // parks it; the separate visibility layout effect (deps isActive/isPaintable)
    // does NOT re-run when the viewport first appears (slotViewportReady flip) or
    // on remount, so the shell must be un-parked here — before the initial
    // `webview.src` is assigned — or the guest navigates while hidden and stays
    // blank/about:blank.
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
        // Why: normalize IPC rejection to false so the dom-ready fallback can
        // retry attach-policy races without an unhandled promise rejection.
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
      // Why: certificate failures can happen before dom-ready. Register at
      // attach so main can map the initial failure to this page; dom-ready below
      // remains an idempotent fallback for attach-policy races.
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

    webview.addEventListener('did-attach', handleDidAttach)
    webview.addEventListener('dom-ready', handleDomReady)
    webview.addEventListener('focus', dismissAddressBarSuggestions)
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
      // Only non-blank initial tabs should light up Orca's loading indicator.
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

      // Why: park the viewport when chrome unmounts (worktree switch) so the
      // guest stays alive. Destruction is reserved for explicit close paths.
      moveFocusToRendererBeforeWebviewDetach(webview)
      parkBrowserPageViewport(browserTab.id)
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
    // Why: slotViewportReady gates viewport creation. Re-run once the viewport
    // exists so visibility AND the chrome-inset measurement land on a real shell
    // (the first render no-ops because ensureBrowserPageViewport returned null).
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
      // Why: newly attached guests can briefly reject getURL() before the
      // underlying guest is fully ready. Skip entirely so we do not
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
        // Why: the guest can still be mid-attach while the loading spinner is
        // visible. Polling is only a fallback for missed failure events, so
        // transient getURL() errors should be ignored until the next tick.
      }
    }

    // Why: some Electron builds paint Chromium's internal chrome-error page
    // without delivering a timely did-fail-load event to the renderer webview.
    // Polling only while the active tab is "loading" gives Orca a last-resort
    // path to swap the black guest surface without waking every retained
    // inactive browser pane on a 250ms loop.
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
    const shortcutPlatform = getShortcutPlatform()
    const handleKeyDown = (e: KeyboardEvent): void => {
      // Why: let native Cmd+C work in text inputs (address bar, search fields,
      // contentEditable regions). Only intercept when focus is on a non-input
      // element so grab-mode toggle doesn't swallow copy in form controls.
      if (isEditableKeyboardTarget(e.target)) {
        return
      }
      // Why: while the markup overlay is open, don't let the grab shortcut start
      // the in-guest picker behind it — matching the disabled grab toolbar buttons.
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
      // Why: Cmd/Ctrl+L is a browser-local focus command. Capture it before
      // the surrounding workspace or any embedded editor surface can treat the
      // same chord as something else.
      e.preventDefault()
      e.stopPropagation()
      focusAddressBarNow()
    }
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [focusAddressBarNow, isActive, keybindings])

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
    // Why: desktop reclaim uses a React overlay, but Electron webviews can
    // keep receiving native input unless their own hit testing is disabled.
    webview.style.pointerEvents = inputLocked ? 'none' : 'auto'
  }, [inputLocked])

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

      // Why: browser drops open one URL; multi-path drags must not silently
      // degrade into opening whichever selected file happened to lead.
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
      // Why: automation-visible and mobile-driven webviews must stay paintable,
      // but hidden toolbar and guest content cannot stay keyboard-focusable.
      inert={!isActive}
      aria-hidden={!isActive}
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
