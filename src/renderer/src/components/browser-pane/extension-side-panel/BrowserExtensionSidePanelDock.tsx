import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from 'react'
import { createPortal } from 'react-dom'
import { Puzzle, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { getBrowserPageRuntimeEnvironmentId } from '../../../../../shared/browser/browser-page-runtime-owner'
import {
  BROWSER_EXTENSION_SIDE_PANEL_MIN_WIDTH,
  type BrowserExtensionSidePanel
} from '../../../../../shared/browser/extensions/browser-extension-side-panel-types'
import {
  getBrowserOverlaySlotViewport,
  subscribeBrowserOverlaySlotViewport
} from '../host-guest/viewport/browser-page-viewport'
import {
  getBrowserPageChromeInsetHeight,
  subscribeBrowserPageChromeInsets
} from '../host-guest/viewport/browser-page-chrome-inset-heights'
import { acquireWebviewsDragPassthrough } from '../host-guest/drag/webview-drag-passthrough'
import { getBrowserPagesForWorkspace } from '../assemble-chrome/browser-pane-page-selection'
import {
  resolveVisibleBrowserExtensionSidePanel,
  useBrowserExtensionSidePanels
} from './browser-extension-side-panel-store'
import {
  ensureBrowserExtensionSidePanelHost,
  layoutBrowserExtensionSidePanelHost,
  setBrowserExtensionSidePanelWidth,
  syncBrowserExtensionSidePanelWebviews
} from './browser-extension-side-panel-webviews'
import { isClientHostedBrowserPageHandle } from '@/store/slices/browser/hosts/browser-host-state'

// Why a cap: a wide panel must leave the page usable, as Chrome's two-thirds limit does.
const MAX_PANE_SHARE = '66.667%'
const MIN_WIDTH = BROWSER_EXTENSION_SIDE_PANEL_MIN_WIDTH
const KEYBOARD_STEP = 16

function panelWidthValue(width: number): string {
  return `min(${width}px, ${MAX_PANE_SHARE})`
}

function useChromeInsetHeight(browserPageId: string | null): number {
  const subscribe = useCallback(
    (listener: () => void) =>
      subscribeBrowserPageChromeInsets((changed) => {
        if (changed === browserPageId) {
          listener()
        }
      }),
    [browserPageId]
  )
  return useSyncExternalStore(subscribe, () =>
    browserPageId ? (getBrowserPageChromeInsetHeight(browserPageId) ?? 0) : 0
  )
}

function SidePanelResizeHandle({
  root,
  slotRoot
}: {
  root: HTMLDivElement
  slotRoot: HTMLDivElement
}): React.JSX.Element {
  const t = useTranslate()
  const width = useAppStore((s) => s.browserExtensionSidePanelWidth)
  const setWidth = useAppStore((s) => s.setBrowserExtensionSidePanelWidth)
  const cleanupRef = useRef<(() => void) | null>(null)
  const [maxWidth, setMaxWidth] = useState<number | undefined>(undefined)
  useLayoutEffect(() => () => cleanupRef.current?.(), [])
  const readMaxWidth = useCallback(
    () => Math.max(MIN_WIDTH, Math.round((slotRoot.getBoundingClientRect().width * 2) / 3)),
    [slotRoot]
  )
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
        return
      }
      event.preventDefault()
      // The panel sits on the right, so ArrowLeft widens it.
      const direction = event.key === 'ArrowLeft' ? 1 : -1
      const step = KEYBOARD_STEP * (event.shiftKey ? 4 : 1)
      const max = readMaxWidth()
      setMaxWidth(max)
      setWidth(Math.min(max, Math.max(MIN_WIDTH, Math.min(width, max) + direction * step)))
    },
    [readMaxWidth, setWidth, width]
  )
  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || cleanupRef.current) {
        return
      }
      event.preventDefault()
      const handle = event.currentTarget
      handle.setPointerCapture(event.pointerId)
      // Pages and the panel itself would swallow the drag.
      const releasePassthrough = acquireWebviewsDragPassthrough()
      const startX = event.clientX
      const startWidth = root.getBoundingClientRect().width
      const max = readMaxWidth()
      let width: number | null = null
      const onMove = (moveEvent: PointerEvent): void => {
        if (moveEvent.pointerId !== event.pointerId) {
          return
        }
        if (moveEvent.buttons === 0) {
          cleanup()
          return
        }
        width = Math.min(max, Math.max(MIN_WIDTH, startWidth + startX - moveEvent.clientX))
        // Why straight to the style: one store write per drag, not one per frame.
        setBrowserExtensionSidePanelWidth(slotRoot, panelWidthValue(width))
      }
      const cleanup = (): void => {
        handle.removeEventListener('pointermove', onMove)
        handle.removeEventListener('pointerup', cleanup)
        handle.removeEventListener('pointercancel', cleanup)
        releasePassthrough()
        cleanupRef.current = null
        // Why only after a move: the rendered width may be capped by a narrow pane.
        if (width !== null) {
          setWidth(width)
        }
      }
      handle.addEventListener('pointermove', onMove)
      handle.addEventListener('pointerup', cleanup)
      handle.addEventListener('pointercancel', cleanup)
      cleanupRef.current = cleanup
    },
    [readMaxWidth, root, setWidth, slotRoot]
  )
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={t(
        'auto.components.browser.pane.BrowserExtensionSidePanelDock.resize',
        'Resize side panel'
      )}
      aria-valuemin={MIN_WIDTH}
      aria-valuemax={maxWidth}
      aria-valuenow={maxWidth === undefined ? width : Math.min(width, maxWidth)}
      tabIndex={0}
      className="absolute top-0 bottom-0 -left-1 z-10 w-2 cursor-col-resize outline-none focus-visible:ring-1 focus-visible:ring-ring"
      onFocus={() => setMaxWidth(readMaxWidth())}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    />
  )
}

function SidePanelHeader({ panel }: { panel: BrowserExtensionSidePanel }): React.JSX.Element {
  const t = useTranslate()
  const closeLabel = t(
    'auto.components.browser.pane.BrowserExtensionSidePanelDock.close',
    'Close side panel'
  )
  return (
    <div className="flex h-7 items-center gap-1.5 border-b border-border pr-1 pl-2">
      {panel.iconDataUrl ? (
        <img alt="" src={panel.iconDataUrl} className="size-3.5 shrink-0" />
      ) : (
        <Puzzle className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="mr-auto truncate text-xs text-muted-foreground">{panel.name}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={closeLabel}
            onClick={() => void window.api.browser.extensionsSidePanelClose({ panelId: panel.id })}
          >
            <X />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {closeLabel}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function SidePanelDockBody({
  workspace,
  isPaintable,
  clientPageId,
  panels: allPanels
}: {
  workspace: BrowserWorkspace
  isPaintable: boolean
  clientPageId: string | null
  panels: readonly BrowserExtensionSidePanel[]
}): React.JSX.Element | null {
  // Why: a workspace switched to another profile must not keep the old profile's extensions open.
  // SSH and This-device pages run their local profile's extensions as an instance of their own.
  const profileId = workspace.sessionProfileId ?? 'default'
  const panels = useMemo(
    () => allPanels.filter((panel) => panel.browserProfileId === profileId),
    [allPanels, profileId]
  )
  useEffect(() => {
    for (const panel of allPanels) {
      if (panel.browserProfileId !== profileId) {
        void window.api.browser.extensionsSidePanelClose({ panelId: panel.id })
      }
    }
  }, [allPanels, profileId])
  const slotRoot = useSyncExternalStore(
    useCallback(
      (listener: () => void) => subscribeBrowserOverlaySlotViewport(workspace.id, listener),
      [workspace.id]
    ),
    () => getBrowserOverlaySlotViewport(workspace.id)
  )
  const activePage = useAppStore((s) => {
    const pages = getBrowserPagesForWorkspace(s.browserPagesByWorkspace, workspace.id)
    return pages.find((page) => page.id === workspace.activePageId) ?? pages[0] ?? null
  })
  const activeRuntimeEnvironmentId = useAppStore((s) =>
    runtimeEnvironmentIdOrLocalUnlessTwin(s, workspace.worktreeId)
  )
  const width = useAppStore((s) => s.browserExtensionSidePanelWidth)
  // Only this desktop's URL pages lay out beside the panel; streamed and document pages draw elsewhere.
  const pageIsLocal = Boolean(
    activePage &&
    !activePage.docLocation &&
    (activePage.id === clientPageId ||
      !getBrowserPageRuntimeEnvironmentId(activePage, activeRuntimeEnvironmentId))
  )
  const activePageId = activePage?.id ?? null
  const visible = pageIsLocal ? resolveVisibleBrowserExtensionSidePanel(panels, activePageId) : null
  const visibleId = visible?.id ?? null
  useEffect(() => {
    // Why: main routes the panel's keys and clicks to the page it sits beside.
    if (visibleId && activePageId) {
      void window.api.browser.extensionsSidePanelShown({
        panelId: visibleId,
        browserPageId: activePageId
      })
    }
  }, [activePageId, visibleId])
  const chromeInsetHeight = useChromeInsetHeight(activePageId)
  const host = useMemo(
    () => (slotRoot ? ensureBrowserExtensionSidePanelHost(workspace.id, slotRoot) : null),
    [slotRoot, workspace.id]
  )

  useLayoutEffect(() => {
    if (!host || !slotRoot) {
      return
    }
    // Why paintable: a <webview> that starts loading inside a hidden slot stays blank.
    syncBrowserExtensionSidePanelWebviews(host, panels, visible?.id ?? null, isPaintable)
    layoutBrowserExtensionSidePanelHost(
      host,
      slotRoot,
      visible ? { width: panelWidthValue(width), top: chromeInsetHeight } : null
    )
  }, [chromeInsetHeight, host, isPaintable, panels, slotRoot, visible, width])

  useLayoutEffect(
    () => () => {
      // Why on unmount: the last panel closed, so the pages take the full width again.
      if (host && slotRoot) {
        layoutBrowserExtensionSidePanelHost(host, slotRoot, null)
        syncBrowserExtensionSidePanelWebviews(host, [], null, false)
      }
    },
    [host, slotRoot]
  )

  if (!host || !slotRoot || !visible) {
    return null
  }
  return createPortal(
    <>
      <SidePanelResizeHandle root={host.root} slotRoot={slotRoot} />
      <SidePanelHeader panel={visible} />
    </>,
    host.chrome
  )
}

/** Extension side panels (chrome.sidePanel) docked on the right of a browser workspace's pages. */
export function BrowserExtensionSidePanelDock({
  workspace,
  isPaintable
}: {
  workspace: BrowserWorkspace
  /** False while the workspace's slot is hidden; panels get their guest once it can paint. */
  isPaintable: boolean
}): React.JSX.Element | null {
  // A This-device page's panels are keyed by the page: main has no workspace for it (see main's
  // browserExtensionSidePanelWorkspaceForPage), and it sits alone in its browser tab.
  const clientPageId = useAppStore((s) => {
    const handle = workspace.activePageId
      ? s.remoteBrowserPageHandlesByPageId[workspace.activePageId]
      : undefined
    return handle && isClientHostedBrowserPageHandle(handle)
      ? (workspace.activePageId ?? null)
      : null
  })
  const panels = useBrowserExtensionSidePanels(clientPageId ?? workspace.id)
  return panels.length > 0 ? (
    <SidePanelDockBody
      workspace={workspace}
      isPaintable={isPaintable}
      clientPageId={clientPageId}
      panels={panels}
    />
  ) : null
}
