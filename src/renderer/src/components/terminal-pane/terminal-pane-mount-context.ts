import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { DeferredSplitPaneHandoffHandle } from './deferred-split-pane-handoff'
import type {
  TerminalHttpLinkActionDestinations,
  TerminalLinkRoutingPreferenceRequester
} from './terminal-url-link-hit-testing'
import type { PtyConnectionDeps } from './pty-connection-types'
import type { LinkHandlerDeps } from './terminal-link-handlers'
import type { TerminalPaneLifecycleRefs } from './use-terminal-pane-lifecycle-refs'
import type { UseTerminalPaneLifecycleDeps } from './terminal-pane-lifecycle-types'
import type { TerminalLinkActionContext } from './terminal-link-action-request'
import type { resolveTerminalHttpLinkSourceOwner } from './terminal-http-link-source-owner'
import type { SessionRestoredBannerReason } from './session-restored-banner-pane-state'

export type TerminalPaneMountContext = {
  deps: UseTerminalPaneLifecycleDeps
  refs: TerminalPaneLifecycleRefs
  ptyDeps: PtyConnectionDeps
  /** Mount-local: numeric pane ids are remount-scoped, the handles are keyed by tab/leaf identity. */
  deferredSplitHandoffs: Map<number, DeferredSplitPaneHandoffHandle>
  startupWithSetupSplitWait: PtyConnectionDeps['startup']
  startupCwd: string
  defaultTabCwd: string
  worktreePath: string
  terminalHomePath: string | null
  wslDistro: string | null
  linkDeps: LinkHandlerDeps
  fileOpenLinkHint: string
  getPaneLinkCwd: (paneId: number) => string
  getUrlOpenLinkHint: (paneId: number) => string
  getHttpLinkSourceOwnerForPane: (
    paneId: number
  ) => ReturnType<typeof resolveTerminalHttpLinkSourceOwner>
  getHttpLinkActionDestinations: (paneId: number) => TerminalHttpLinkActionDestinations
  getLinkActionContext: (paneId: number) => TerminalLinkActionContext | null
  canOpenOwnedBrowserForPane: (paneId: number) => boolean
  requestOpenLinksInAppPreference: TerminalLinkRoutingPreferenceRequester
  onShowSessionRestoredBanner: (paneId: number, reason?: SessionRestoredBannerReason) => void
  queueResizeAll: (focusActive: boolean) => void
  syncPaneCount: () => void
  syncPaneLayoutRevision: () => void
  syncCanExpandState: () => void
  applyAppearance: (manager: PaneManager) => void
  releaseWebviewDragPassthrough: { current: (() => void) | null }
}

/** Additional values captured while constructing a PaneManager's option bag. */
export type TerminalPaneManagerOptionsContext = TerminalPaneMountContext & {
  shouldPersistLayout: () => boolean
  startup: PtyConnectionDeps['startup']
  osc7UncHost: string | null
}

export type PaneCreatedHandlerContext = TerminalPaneManagerOptionsContext

export type PaneClosedHandlerContext = TerminalPaneMountContext & {
  paneId: number
  closedPane?: { leafId: string; reason?: 'close' | 'detach' | 'retire' }
}
