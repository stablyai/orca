import type { BrowserScreencastFrameMetadata } from '../../../../../shared/browser/screencast/browser-screencast-protocol'
import type { RemoteBrowserHostContextMenus } from './remote-browser-host-context-menus'
import type { RemoteBrowserInputQueue } from './remote-browser-input-queue'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type {
  RemoteBrowserOperationToken,
  RemoteBrowserViewportSize
} from './remote-browser-stream-tokens'
import type {
  RemoteBrowserPaneNotice,
  RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'

/** The keyboard proxy's handlers: keys, pastes, and text the input method or layout produced. */
export type RemoteBrowserKeyboardProxyHandlers = {
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  onText: React.ReactEventHandler<HTMLTextAreaElement>
}

/** What a streamed page's pointer and keyboard input needs from its pane. */
export type RemoteBrowserPageInputParams = {
  busy: boolean
  pickerAvailable: boolean
  /** A page tool (the element picker) owns the pointer: right presses go to the page. */
  pagePointerOwned: boolean
  /** When the host reports page menus, right presses go to the page and its menu opens from the host's report. */
  hostContextMenus: RemoteBrowserHostContextMenus
  inputQueue: RemoteBrowserInputQueue
  imageRef: React.RefObject<HTMLImageElement | null>
  keyboardProxyRef: React.RefObject<HTMLTextAreaElement | null>
  remoteViewportRef: React.RefObject<HTMLDivElement | null>
  remoteCssViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  remoteViewportSizeRef: React.MutableRefObject<RemoteBrowserViewportSize | null>
  frameMetadata: BrowserScreencastFrameMetadata | null
  runtimeTarget: () => RemoteBrowserRuntimeTarget | null
  lifecycle: RemoteBrowserStreamLifecycle
  runtimeWorktree: string
  enqueueRemoteInput: (operation: () => Promise<void>) => Promise<void>
  createRemoteOperationToken: (remotePageId?: string | null) => RemoteBrowserOperationToken | null
  isCurrentRemoteOperationToken: (token: RemoteBrowserOperationToken) => boolean
  closeMissingRemotePage: (remotePageId?: string | null) => void
  scheduleRemoteTabInfoRefresh: (token: RemoteBrowserOperationToken, delayMs?: number) => void
  isActive: boolean
  mountedRef: React.RefObject<boolean>
  setPaneNotice: (notice: RemoteBrowserPaneNotice | null) => void
  getPageUrl: () => string
}
