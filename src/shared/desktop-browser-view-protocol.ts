import type { BrowserLoadError } from './browser-workspace-types'
import type { DesktopBrowserViewInput } from './desktop-browser-view-input'

export type DesktopBrowserViewIdentity = {
  browserPageId: string
  generation: string
}

export type DesktopBrowserViewBounds = {
  x: number
  y: number
  width: number
  height: number
}

export type DesktopBrowserViewCreateArgs = {
  browserPageId: string
  workspaceId: string
  worktreeId: string
  sessionProfileId: string | null
  url: string
}

export type DesktopBrowserViewState = DesktopBrowserViewIdentity & {
  revision: number
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  faviconUrl: string | null
  loadError: BrowserLoadError | null
  zoomLevel: number
  focused: boolean
}

export type DesktopBrowserViewLayout = DesktopBrowserViewIdentity & {
  bounds: DesktopBrowserViewBounds
  clipBounds?: DesktopBrowserViewBounds
  visible: boolean
  inputLocked: boolean
  forwardInput?: boolean
}

export type DesktopBrowserViewInputArgs = DesktopBrowserViewIdentity & {
  input: DesktopBrowserViewInput
}

export type DesktopBrowserViewCommand =
  | { kind: 'snapshot' }
  | { kind: 'navigate'; url: string }
  | { kind: 'back' }
  | { kind: 'forward' }
  | { kind: 'reload'; ignoreCache: boolean }
  | { kind: 'stop' }
  | { kind: 'zoom'; level: number }
  | {
      kind: 'find'
      text: string
      forward: boolean
      findNext: boolean
      matchCase: boolean
    }
  | { kind: 'stop-find'; action: 'clearSelection' | 'keepSelection' | 'activateSelection' }
  | { kind: 'focus' }
  | { kind: 'blur' }

export type DesktopBrowserViewCommandArgs = DesktopBrowserViewIdentity & {
  command: DesktopBrowserViewCommand
}

export type DesktopBrowserViewFindResult = {
  requestId: number
  activeMatchOrdinal: number
  matches: number
  finalUpdate: boolean
}

export type DesktopBrowserViewEvent =
  | { kind: 'state'; state: DesktopBrowserViewState }
  | (DesktopBrowserViewIdentity & { kind: 'found-in-page'; result: DesktopBrowserViewFindResult })
  | (DesktopBrowserViewIdentity & { kind: 'destroyed' })
  | (DesktopBrowserViewIdentity & { kind: 'page-ready' })
  | (DesktopBrowserViewIdentity & {
      kind: 'navigation-start' | 'navigation-commit'
      url: string
      sameDocument: boolean
    })
  | (DesktopBrowserViewIdentity & { kind: 'renderer-gone'; reason: string })
  | (DesktopBrowserViewIdentity & {
      kind: 'annotation-viewport'
      token: string
      scrollX: number
      scrollY: number
    })

export type DesktopBrowserViewCommandResult = {
  state: DesktopBrowserViewState
  findRequestId?: number
}

export type DesktopBrowserViewCapture = {
  dataUrl: string
  width: number
  height: number
}

/** Present only in the local desktop preload, never on remote browser transports. */
export type DesktopBrowserViewApi = {
  create: (args: DesktopBrowserViewCreateArgs) => Promise<DesktopBrowserViewState>
  updateLayout: (args: DesktopBrowserViewLayout) => Promise<void>
  command: (args: DesktopBrowserViewCommandArgs) => Promise<DesktopBrowserViewCommandResult>
  input: (args: DesktopBrowserViewInputArgs) => Promise<void>
  captureViewport: (args: DesktopBrowserViewIdentity) => Promise<DesktopBrowserViewCapture>
  close: (args: DesktopBrowserViewIdentity) => Promise<void>
  onEvent: (listener: (event: DesktopBrowserViewEvent) => void) => () => void
}
