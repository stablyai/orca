import { useAppStore } from '@/store/index'
import { createWebRuntimeSessionBrowserTabOnHost } from '@/runtime/browser/creation/web-runtime-browser-creation'
import { resolveBrowserSourceUnifiedTab } from '@/lib/browser/workspace/browser-workspace-source-resolution'
import { captureRuntimeEnvironmentCall } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { hasUnsentBrowserNotes } from '@/store/slices/browser/annotations/browser-page-annotation'
import {
  guardPinnedTabClose,
  resolvePinnedTabLabel
} from '@/store/slices/tabs/closing/pinned-tab-close-guard'
import type { AppState } from '@/store/types'
import type { RemoteBrowserPageHandle } from '@/store/slices/browser/browser-slice-contract'
import {
  moveWebRuntimeSessionTab,
  resolveHostTabDropTarget
} from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-move'
import { isDesktopCreatedTabInFrameDrawnServerWorkspace } from '@/store/workspace-layout/frames/frame-drawn-desktop-created-tabs'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../../shared/workspace-layout/layout-owner-switch'
import type { Tab } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'
import { normalizeBrowserNavigationUrl } from '../../../../../../shared/browser/navigation/browser-url'
import { ORCA_BROWSER_BLANK_URL } from '../../../../../../shared/browser/browser-blank-page'

/** Where the page renders after the move: this desktop ('client') or the paired server ('server'). */
export type BrowserPageMoveDestination = 'client' | 'server'

/** Only web addresses move; blank tabs, file previews and request bodies have nothing the other side could reopen. */
export function resolveBrowserPageMoveUrl(url: string | null | undefined): string | undefined {
  if (typeof url !== 'string') {
    return undefined
  }
  let normalized: string | null = null
  try {
    normalized = normalizeBrowserNavigationUrl(url)
  } catch {
    return undefined
  }
  if (!normalized || normalized === ORCA_BROWSER_BLANK_URL || normalized.startsWith('file:')) {
    return undefined
  }
  return normalized
}

/** A blank or absent address reopens blank on the other side; anything else must be a web address to leave its tab. */
function addressSurvivesMove(url: string | null | undefined): boolean {
  if (resolveBrowserPageMoveUrl(url) !== undefined || typeof url !== 'string') {
    return true
  }
  try {
    return normalizeBrowserNavigationUrl(url) === ORCA_BROWSER_BLANK_URL
  } catch {
    return false
  }
}

const movingPageIds = new Set<string>()

/** 'source-close-failed': the page opened on the other side but its old tab couldn't be closed. */
export type BrowserPageMoveOutcome = 'moved' | 'failed' | 'source-close-failed'

/** Opens the page's address on the other side, in its profile and strip spot, then closes it. History, page state and logins stay behind. */
export async function moveBrowserPageAcrossDevices(args: {
  browserPageId: string
  worktreeId: string
  environmentId: string
  destination: BrowserPageMoveDestination
  url: string | null | undefined
}): Promise<BrowserPageMoveOutcome> {
  const { browserPageId, worktreeId, environmentId } = args
  // A second click while the first move is in flight would open a second copy.
  if (movingPageIds.has(browserPageId)) {
    return 'moved'
  }
  movingPageIds.add(browserPageId)
  const state = useAppStore.getState()
  const source = resolveBrowserSourceUnifiedTab(state, browserPageId, worktreeId)
  // Any navigation of the source while the move runs means it isn't the page that moved.
  const navigation = source ? watchPageNavigation(source.entityId, browserPageId) : null
  try {
    // Desktop split ids can differ from the server's; name the group as the server does. The new tab
    // is in no group yet, so the source itself still counts as evidence of the server group.
    const hostGroup = source
      ? await resolveHostTabDropTarget(environmentId, {
          worktreeId,
          tabId: '',
          targetGroupId: source.groupId
        })
      : null
    let createdRemotePageId: string | null = null
    const created = await createWebRuntimeSessionBrowserTabOnHost(
      {
        worktreeId,
        environmentId,
        url: resolveBrowserPageMoveUrl(args.url),
        // The server's profile id: each side keeps its own cookie jar for it, so nothing crosses.
        profileId: state.remoteBrowserPageHandlesByPageId[browserPageId]?.browserProfileId ?? null,
        placementPreference: args.destination,
        focusOnCreate: true,
        selectWorktree: false,
        ...(source && hostGroup
          ? {
              targetGroupId: hostGroup.targetGroupId,
              clientTargetGroupId: source.groupId,
              clientAfterTabId: source.id
            }
          : {}),
        onMaterialized: (remotePageId) => {
          createdRemotePageId = remotePageId
        }
      },
      environmentId
    )
    if (!created) {
      return 'failed'
    }
    // A move here succeeds only if the page landed client-placed; a server row omits placement.
    if (
      args.destination === 'client' &&
      createdRemotePageId &&
      findRemotePageHandle(useAppStore.getState(), environmentId, createdRemotePageId)?.placement
        ?.kind !== 'client'
    ) {
      await closeRemotePage(environmentId, worktreeId, createdRemotePageId)
      return 'failed'
    }
    // Reorder first: once the source's close settles, an order still naming it would be refused.
    if (createdRemotePageId) {
      try {
        await keepServerTabOrder(worktreeId, environmentId, createdRemotePageId)
      } catch (error) {
        console.warn('[browser-device-move] keeping the server tab order failed:', error)
      }
    }
    // A file or other non-web address opened blank on the other side; keep the original.
    if (source && navigation && addressSurvivesMove(args.url)) {
      const closed = await closeMovedSourcePage(
        worktreeId,
        environmentId,
        source,
        browserPageId,
        navigation
      )
      return closed ? 'moved' : 'source-close-failed'
    }
    return 'moved'
  } finally {
    navigation?.stop()
    movingPageIds.delete(browserPageId)
  }
}

type PageNavigationWatch = { navigated: () => boolean; stop: () => void }

function watchPageNavigation(workspaceId: string, browserPageId: string): PageNavigationWatch {
  const pageOf = (pages: AppState['browserPagesByWorkspace']) =>
    (pages[workspaceId] ?? []).find((page) => page.id === browserPageId)
  const initial = pageOf(useAppStore.getState().browserPagesByWorkspace)
  // A page still loading can start another navigation unseen, so it is never closed as moved.
  let navigated = initial?.loading === true
  // A new address, or a load starting (a slow or same-address navigation keeps the old URL until it commits).
  const stop = useAppStore.subscribe((next, previous) => {
    if (navigated || next.browserPagesByWorkspace === previous.browserPagesByWorkspace) {
      return
    }
    const page = pageOf(next.browserPagesByWorkspace)
    const before = pageOf(previous.browserPagesByWorkspace)
    if (page?.url !== initial?.url || (page?.loading === true && before?.loading !== true)) {
      navigated = true
    }
  })
  return { navigated: () => navigated, stop }
}

/** False only when the server refused or missed the close; a source kept on purpose counts as done. */
function closeMovedSourcePage(
  worktreeId: string,
  environmentId: string,
  source: Tab,
  browserPageId: string,
  navigation: PageNavigationWatch
): Promise<boolean> {
  const state = useAppStore.getState()
  const live = (state.unifiedTabsByWorktree[worktreeId] ?? []).find((tab) => tab.id === source.id)
  // A pinned tab's close asks first, on the server's screen too, so it stays; the ⋯ item is hidden
  // for pinned tabs. A page that navigated isn't the page that moved, so it stays too.
  if (!live || !stillTheMovedPage(live, browserPageId, navigation)) {
    return Promise.resolve(true)
  }
  return new Promise<boolean>((resolve) => {
    // Unsent notes still need the person's say-so.
    guardPinnedTabClose({
      isPinned: false,
      tabLabel: resolvePinnedTabLabel(state, worktreeId, live.id),
      onClose: () => {
        const current = useAppStore.getState()
        const tab = (current.unifiedTabsByWorktree[worktreeId] ?? []).find((t) => t.id === live.id)
        const handle = current.remoteBrowserPageHandlesByPageId[browserPageId]
        if (!tab || !handle || !stillTheMovedPage(tab, browserPageId, navigation)) {
          resolve(true)
          return
        }
        // Close the page itself on its server, as `tab close --page` does: a server tab holding
        // other pages keeps them, and the strip drops this row when the server publishes it.
        void closeRemotePage(environmentId, worktreeId, handle.remotePageId).then(resolve)
      },
      onCancel: () => resolve(true),
      unsentNotes: hasUnsentBrowserNotes(state, live.entityId)
    })
  })
}

async function closeRemotePage(
  environmentId: string,
  worktreeId: string,
  remotePageId: string
): Promise<boolean> {
  try {
    unwrapRuntimeRpcResult(
      await captureRuntimeEnvironmentCall(environmentId)({
        method: 'browser.tabClose',
        params: { worktree: toRuntimeWorktreeSelector(worktreeId), page: remotePageId },
        timeoutMs: 15_000
      })
    )
    return true
  } catch (error) {
    console.warn('[browser-device-move] closing a page failed:', error)
    return false
  }
}

function stillTheMovedPage(
  tab: Tab,
  browserPageId: string,
  navigation: PageNavigationWatch
): boolean {
  const pages = useAppStore.getState().browserPagesByWorkspace[tab.entityId] ?? []
  return !tab.isPinned && !navigation.navigated() && pages.some((page) => page.id === browserPageId)
}

/** The server appended the new tab; place it as a drag does, so other devices see it in the old spot. */
async function keepServerTabOrder(
  worktreeId: string,
  environmentId: string,
  remotePageId: string
): Promise<void> {
  const state = useAppStore.getState()
  const tab = findRemotePageTab(state, worktreeId, environmentId, remotePageId)
  const group = (state.groupsByWorktree[worktreeId] ?? []).find((g) => g.id === tab?.groupId)
  if (
    !tab ||
    !group?.tabOrder.includes(tab.id) ||
    // As a drag does: main's frames place tabs the server never owned.
    (ORCA_LAYOUT_OWNER_IS_MAIN &&
      isDesktopCreatedTabInFrameDrawnServerWorkspace(worktreeId, tab.id))
  ) {
    return
  }
  // The page's own server, even if another host got selected while the move ran. Some servers
  // open new tabs in their active split, so join this group first (a no-op when already there),
  // then take this strip's order. Ordering is cosmetic for other devices; the move still completes.
  await moveWebRuntimeSessionTab({
    kind: 'move-to-group',
    worktreeId,
    environmentId,
    tabId: tab.id,
    targetGroupId: group.id,
    index: group.tabOrder.indexOf(tab.id)
  })
  await moveWebRuntimeSessionTab({
    kind: 'reorder',
    worktreeId,
    environmentId,
    tabId: tab.id,
    targetGroupId: group.id,
    tabOrder: group.tabOrder
  })
}

function findRemotePageHandle(
  state: AppState,
  environmentId: string,
  remotePageId: string
): RemoteBrowserPageHandle | undefined {
  return Object.values(state.remoteBrowserPageHandlesByPageId).find(
    (handle) => handle.environmentId === environmentId && handle.remotePageId === remotePageId
  )
}

function findRemotePageTab(
  state: AppState,
  worktreeId: string,
  environmentId: string,
  remotePageId: string
): Tab | undefined {
  const workspace = (state.browserTabsByWorktree[worktreeId] ?? []).find((candidate) =>
    (state.browserPagesByWorkspace[candidate.id] ?? []).some((page) => {
      const handle = state.remoteBrowserPageHandlesByPageId[page.id]
      return handle?.environmentId === environmentId && handle.remotePageId === remotePageId
    })
  )
  return workspace
    ? (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.contentType === 'browser' && tab.entityId === workspace.id
      )
    : undefined
}
