import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import type { BrowserExtensionMenuItem } from '../../../../../shared/browser-guest-events'
import type { BrowserGrabPayload } from '../../../../../shared/browser-grab-types'
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

export type BrowserPageContextMenuState = {
  x: number
  y: number
  linkUrl: string | null
  pageUrl: string
  selectionText: string
  extensionMenuItems: BrowserExtensionMenuItem[]
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
  /**
   * The id main resolves to a guest. Defaults to the annotation scope, which is the same string
   * for a browser page — a preview re-mints this on recovery, and its annotations must not be
   * orphaned when it does.
   */
  toolTargetId?: string
  isActive: boolean
  grab: GrabModeHook
  containerRef: MutableRefObject<HTMLDivElement | null>
  trackingContainer?: HTMLDivElement | null
  trackingScroller?: HTMLDivElement | null
  webviewRef: MutableRefObject<Electron.WebviewTag | null>
  setBrowserOverlayViewport: Dispatch<SetStateAction<BrowserOverlayViewport>>
  browserAnnotationsLength: number
  setBrowserAnnotationTrayOpen: Dispatch<SetStateAction<boolean>>
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
