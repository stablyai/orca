import type { AppState } from '@/store/types'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import type { TabSplitTarget } from '@/store/slices/tabs/tabs-slice-contract'
import type { Tab, TabGroup } from '../../../shared/tab-types'
import { liveLayoutGroupIds } from '@/store/slices/editor/tabs/editor-open-target-group'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import type { OpenWorkspaceBrowserTabRequest } from './workspace-browser-tab-open'
import type { BrowserWorkspace } from '../../../shared/browser-workspace-types'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'

export type HttpLinkBrowserPlacement = { targetGroupId: string } | { split: TabSplitTarget }

export type HttpLinkBrowserTabState = Partial<
  Pick<AppState, 'layoutByWorktree' | 'activeGroupIdByWorktree' | 'activeView' | 'setActiveView'>
> & {
  groupsByWorktree?: Record<string, readonly Pick<TabGroup, 'id' | 'activeTabId'>[]>
  unifiedTabsByWorktree?: Record<
    string,
    readonly (Pick<Tab, 'id'> & Partial<Pick<Tab, 'contentType'>>)[]
  >
  settings?: Partial<Pick<GlobalSettings, 'openLinksInAppInBackground'>> | null
  createBrowserTab: (
    worktreeId: string,
    url: string,
    opts: Pick<CreateBrowserTabOptions, 'activate' | 'targetGroupId' | 'split'>
  ) => Pick<BrowserWorkspace, 'activePageId'> | undefined
}

/** How the remote opener places and focuses a link's tab; same rule as a local link. */
export type HttpLinkBrowserRequestFields = Pick<
  OpenWorkspaceBrowserTabRequest,
  'targetGroupId' | 'split' | 'focusOnCreate' | 'selectWorktree'
>

/**
 * Where a link opened from an Orca surface lands: the browser already on screen, else a split
 * beside the clicked pane so the terminal or agent stays visible. Clicking a pane focuses its
 * group, so the worktree's active group is the link's source.
 */
export function resolveHttpLinkBrowserPlacement(
  state: Omit<HttpLinkBrowserTabState, 'createBrowserTab'>,
  worktreeId: string
): HttpLinkBrowserPlacement | null {
  const groups = state.groupsByWorktree?.[worktreeId] ?? []
  const tabsById = new Map((state.unifiedTabsByWorktree?.[worktreeId] ?? []).map((t) => [t.id, t]))
  const visibleGroupIds = liveLayoutGroupIds(state, worktreeId)
  for (const groupId of visibleGroupIds) {
    const activeTabId = groups.find((group) => group.id === groupId)?.activeTabId
    if (activeTabId && tabsById.get(activeTabId)?.contentType === 'browser') {
      return { targetGroupId: groupId }
    }
  }
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
  placement = resolveHttpLinkBrowserPlacement(state, worktreeId)
): void {
  const background = isHttpLinkBackgroundOpen(state)
  const tab = state.createBrowserTab(worktreeId, url, { activate: !background, ...placement })
  if (background) {
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
function showWorkspaceTabs(
  state: Pick<HttpLinkBrowserTabState, 'activeView' | 'setActiveView'>,
  worktreeId: string
): void {
  if (!isFloatingWorkspaceId(worktreeId) && state.activeView !== 'terminal') {
    state.setActiveView?.('terminal')
  }
}
