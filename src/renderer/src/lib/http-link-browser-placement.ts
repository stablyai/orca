import type { AppState } from '@/store/types'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { liveLayoutGroupIds } from '@/store/slices/editor/tabs/editor-open-target-group'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import type { OpenWorkspaceBrowserTabRequest } from './workspace-browser-tab-open'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { findVisibleBrowserLinkTarget } from './visible-browser-link-target'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'

export type HttpLinkBrowserPlacement = { targetGroupId: string } | { split: TabSplitTarget }

export type HttpLinkBrowserTabState = Partial<
  Pick<AppState, 'layoutByWorktree' | 'activeGroupIdByWorktree' | 'activeView' | 'setActiveView'>
> & {
  groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>
  unifiedTabsByWorktree?: Record<
    string,
    readonly (Pick<Tab, 'id'> & Partial<Pick<Tab, 'contentType' | 'groupId' | 'lastFocusedAt'>>)[]
  >
  settings?: Partial<Pick<GlobalSettings, 'openLinksInAppInBackground'>> | null
  createBrowserTab: (
    worktreeId: string,
    url: string,
    opts: Pick<CreateBrowserTabOptions, 'activate' | 'targetGroupId' | 'split'>
  ) => Pick<BrowserWorkspace, 'activePageId'> | undefined
}

export type HttpLinkBrowserRequestFields = Pick<
  OpenWorkspaceBrowserTabRequest,
  'targetGroupId' | 'split' | 'focusOnCreate' | 'selectWorktree'
>

/** Use the visible browser or split beside the clicked pane so its terminal/agent stays visible; click focus identifies the source group. */
export function resolveHttpLinkBrowserPlacement(
  state: Omit<HttpLinkBrowserTabState, 'createBrowserTab'>,
  worktreeId: string
): HttpLinkBrowserPlacement | null {
  const visibleBrowser = findVisibleBrowserLinkTarget(state, worktreeId)
  if (visibleBrowser) {
    return visibleBrowser
  }
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const visibleGroupIds = liveLayoutGroupIds(state, worktreeId)
  const sourceGroupId = state.activeGroupIdByWorktree?.[worktreeId]
  if (!sourceGroupId || !visibleGroupIds.has(sourceGroupId)) {
    return null
  }
  // Why: an empty pane covers nothing, so the link fills it instead of splitting beside it.
  if (!groups.find((group) => group.id === sourceGroupId)?.activeTabId) {
    return { targetGroupId: sourceGroupId }
  }
  // Why unactivated: a host snapshot reads an activated empty group as a terminal pane (see file-preview.ts).
  return { split: { sourceGroupId, splitDirection: 'right', activate: false } }
}

export function isHttpLinkBackgroundOpen(
  state: Pick<HttpLinkBrowserTabState, 'settings'>
): boolean {
  return state.settings?.openLinksInAppInBackground === true
}

export function openLocalHttpLinkTab(
  state: HttpLinkBrowserTabState,
  worktreeId: string,
  url: string,
  placement = resolveHttpLinkBrowserPlacement(state, worktreeId),
  activate = !isHttpLinkBackgroundOpen(state)
): void {
  const tab = state.createBrowserTab(worktreeId, url, { activate, ...placement })
  if (!activate) {
    return
  }
  showWorkspaceTabs(state, worktreeId)
  focusHttpLinkPage(tab?.activePageId)
}

/** Keyboard focus follows a link's tab, so Cmd/Ctrl+W closes the link rather than its source. */
export function focusHttpLinkPage(pageId: string | null | undefined): void {
  if (pageId) {
    requestBrowserFocus({ pageId, target: 'webview' })
  }
}

export function prepareRemoteHttpLinkTab(
  state: Omit<HttpLinkBrowserTabState, 'createBrowserTab'>,
  worktreeId: string
): HttpLinkBrowserRequestFields {
  const placement = resolveHttpLinkBrowserPlacement(state, worktreeId)
  if (isHttpLinkBackgroundOpen(state)) {
    return { ...placement, focusOnCreate: false, selectWorktree: false }
  }
  showWorkspaceTabs(state, worktreeId)
  return placement ?? {}
}

/** A link clicked in Agents View lands in the workspace's tab layout, so bring that layout on screen. */
export function showWorkspaceTabs(
  state: Pick<HttpLinkBrowserTabState, 'activeView' | 'setActiveView'>,
  worktreeId: string
): void {
  if (!isFloatingWorkspaceId(worktreeId) && state.activeView !== 'terminal') {
    state.setActiveView?.('terminal')
  }
}
