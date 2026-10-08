import type { BrowserPageZoomDirection } from '../../../../../shared/browser-page-zoom'

export type BrowserPageSurfaceOperation = void | Promise<void>

export type BrowserPageSurfaceBounds = {
  height: number
  left: number
  top: number
  width: number
}

export type BrowserPageSurfaceSnapshot = {
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  title: string
  url: string
  zoomLevel: number
}

export type BrowserPageSurfaceViewportCapture = {
  dataUrl: string
  height: number
  width: number
}

export type BrowserPageSurfaceFindResult = {
  activeMatchOrdinal: number
  matches: number
}

/** Renderer chrome contract for a local browser surface, independent of its presenter. */
export type BrowserPageSurface = {
  blur: () => BrowserPageSurfaceOperation
  focus: () => boolean | Promise<boolean>
  captureViewport: () => Promise<BrowserPageSurfaceViewportCapture | null>
  getBounds: () => BrowserPageSurfaceBounds | null
  getSnapshot: () => BrowserPageSurfaceSnapshot | null | Promise<BrowserPageSurfaceSnapshot | null>
  goBack: () => BrowserPageSurfaceOperation
  goForward: () => BrowserPageSurfaceOperation
  isAttached: () => boolean
  navigate: (url: string) => BrowserPageSurfaceOperation
  refresh: () => void
  reload: (ignoreCache: boolean) => BrowserPageSurfaceOperation
  runFind: (text: string, options?: Electron.FindInPageOptions) => BrowserPageSurfaceOperation
  setZoomLevel: (level: number) => number | null | Promise<number | null>
  stepZoom: (
    direction: BrowserPageZoomDirection,
    resetLevel?: number
  ) => number | null | Promise<number | null>
  stop: () => BrowserPageSurfaceOperation
  stopFind: (
    action?: 'clearSelection' | 'keepSelection' | 'activateSelection'
  ) => BrowserPageSurfaceOperation
  subscribeFindResults: (listener: (result: BrowserPageSurfaceFindResult) => void) => () => void
}
