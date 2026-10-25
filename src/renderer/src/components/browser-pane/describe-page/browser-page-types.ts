import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
import type { BrowserContextMenuRequestedEvent } from '../../../../../shared/browser-guest-events'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser-workspace-types'
import type { GrabModeHook } from '../annotate/useGrabMode'
import type { BrowserOverlayViewport } from './browser-annotation-geometry'

export type BrowserTabPageState = Partial<
  Pick<
    BrowserPageState,
    'title' | 'loading' | 'faviconUrl' | 'canGoBack' | 'canGoForward' | 'loadError'
  >
>

export type BrowserPageUrlSetter = (
  tabId: string,
  url: string,
  options?: { preserveLoadError?: boolean }
) => void

export type BrowserChromeShortcutScope = 'focused' | 'inactive' | 'owned-target'

export type { GrabIntent } from '../../../../../shared/browser-grab-types'

export type BrowserPageContextMenuState = Pick<
  BrowserContextMenuRequestedEvent,
  'linkUrl' | 'pageUrl' | 'selectionText' | 'editable' | 'image'
> & {
  x: number
  y: number
  /** Where the click landed in the guest's own viewport, for inspect and copy-image. */
  pagePoint: { x: number; y: number }
}

export type BrowserPageGrabToastState = {
  message: string
  type: 'success' | 'error'
  x: number
  y: number
  below: boolean
  payload: BrowserGrabPayload | null
}

export type BrowserPageGrabAnnotationsOptions = {
  /** Scopes the stored annotations. Stable for the life of the surface. */
  browserTabId: string
  /** Guest target ID defaults to the annotation scope; previews may remint it during recovery without orphaning stored annotations. */
  toolTargetId?: string
  isActive: boolean
  grab: GrabModeHook
  containerRef: MutableRefObject<HTMLDivElement | null>
  trackingContainer?: HTMLDivElement | null
  trackingScroller?: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  browserAnnotationsLength: number
}

export type BrowserPageRecoveryNavigationValidation = {
  committed: boolean
  started: boolean
  targetUrl: string
}

export type BrowserPageNavigateEvent = {
  url?: string
  isMainFrame?: boolean
}

export type BrowserPageFailLoadEvent = {
  errorCode?: number
  errorDescription?: string
  validatedURL?: string
  isMainFrame?: boolean
}

export type ClientHostedBrowserPagePaneProps = {
  browserTab: BrowserPageState
  workspaceId: string
  runtimeEnvironmentId: string
  worktreeId: string
  /** Null while the tab is still an optimistic stage: the host mints the placement, not this client. */
  placement: RuntimeBrowserClientPlacement | null
  isActive: boolean
  chromeShortcutScope: BrowserChromeShortcutScope
  onUpdatePageState: (tabId: string, updates: BrowserTabPageState) => void
  onSetUrl: BrowserPageUrlSetter
}
