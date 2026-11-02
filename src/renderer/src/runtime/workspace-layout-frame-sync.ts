// The window's layout slices drawn from main's layout stream (design phase E2b), in a layout-owner
// build only. Main publishes every workspace it holds; this window shows a frame's workspace when
// it writes that workspace to a partition this machine owns (a paired server's stay the mirror's)
// and already holds it (startup restore keeps only workspaces the catalog knows).
//
// A tab the window drew, closed or moved before main answered stays as drawn until the answer is
// in (layout-owner-drawn-tab-holds); everything else shows as each frame arrives.

import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { applyLayoutFrame, EMPTY_WORKSPACE_LAYOUT_CACHE } from '@/store/workspace-layout-cache'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { buildLayoutFrameSlices, shownLiveTitle } from '@/store/workspace-layout-frame-slices'
import {
  buildLayoutFrameStorePatch,
  terminalLayoutsPatch
} from '@/store/workspace-layout-frame-store-patch'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { pairedServerMirrors } from './paired-server-workspace'
import { splitWorkspaceSessionByHost } from '@/lib/workspace-session-host-split'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import { loadWorkspaceLayoutWithoutReport } from '../../../shared/workspace-layout/workspace-layout-load'
import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { PublishedWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-published'
import {
  beginLayoutFramePositions,
  endLayoutFramePositions,
  noteLayoutFramePosition
} from './layout-frame-position'
import {
  provideLayoutFrameTerminalPanes,
  type LayoutFrameTerminalQueries
} from './layout-frame-terminal-panes'
import {
  isTabPaneTreeHeld,
  onTabPaneTreeRedraw,
  takeTabRowFields
} from './layout-owner-pane-intents'
import {
  isDrawnGroupLayoutHeld,
  isDrawnTabHeld,
  onDrawnTabsRedraw
} from './layout-owner-drawn-tab-holds'
import { subscribeRuntimeLayout } from './runtime-layout-client'

type FrameSyncStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
}

export type WorkspaceLayoutFrameSync = LayoutFrameTerminalQueries & {
  /** Shows every workspace the frames own once the snapshot is in, then keeps them current. */
  start: () => void
  close: () => void
}

/** A bucket, not a host: the view read-back routes the workspaces a rebuild skips here. */
const OTHER_WORKSPACES: ExecutionHostId = 'runtime:frame-sync-other-workspaces'

const structureJsonByLayout = new WeakMap<PublishedWorkspaceLayout, string>()

/** A frame's JSON without live titles, kept per frame: title frames arrive at spinner rate. */
function structureJson(layout: PublishedWorkspaceLayout): string {
  let json = structureJsonByLayout.get(layout)
  if (json === undefined) {
    json = withoutLiveTitles(layout)
    structureJsonByLayout.set(layout, json)
  }
  return json
}

function withoutLiveTitles(layout: PublishedWorkspaceLayout): string {
  return stableJson({
    ...layout,
    tabs: layout.tabs.map((tab) =>
      tab.terminal
        ? {
            ...tab,
            terminal: {
              ...tab.terminal,
              panes: tab.terminal.panes.map(({ liveTitle: _liveTitle, ...pane }) => pane)
            }
          }
        : tab
    )
  })
}

/** Title changes between two frames of one workspace, for the pane each tab shows. */
function liveTitleUpdates(
  shown: PublishedWorkspaceLayout,
  next: PublishedWorkspaceLayout,
  focusedLeafId: (tabId: string) => string | null | undefined
): TerminalTabTitleUpdate[] {
  const shownById = new Map(shown.tabs.map((tab) => [tab.id, tab]))
  const updates: TerminalTabTitleUpdate[] = []
  for (const tab of next.tabs) {
    const shownTab = shownById.get(tab.id)
    if (!tab.terminal || !shownTab) {
      continue
    }
    const focused = focusedLeafId(tab.entityId)
    const title = shownLiveTitle(tab, focused)
    if (title !== undefined && title !== shownLiveTitle(shownTab, focused)) {
      updates.push({ tabId: tab.entityId, title })
    }
  }
  return updates
}

/** Which workspaces frames draw: ones the window holds that no paired server mirrors. */
function framesDrawWorkspace(state: AppState): (key: string) => boolean {
  const mirrored = pairedServerMirrors(state)
  return (key) =>
    (key in state.groupsByWorktree || key in state.unifiedTabsByWorktree) && !mirrored(key)
}

export function openWorkspaceLayoutFrameSync(store: FrameSyncStore): WorkspaceLayoutFrameSync {
  let cache: WorkspaceLayoutCache = EMPTY_WORKSPACE_LAYOUT_CACHE
  /** Workspace key → the frame the store shows. */
  let shown: Record<string, PublishedWorkspaceLayout> = {}
  let started = false
  let live = false
  let snapshotReceived = false
  let flushQueued = false
  let streamOpen = true
  /** Workspaces whose pane trees the store may still lack: a structure frame came in, or a tab
   *  the window's own command held skipped one. */
  let paneTreeKeys = new Set<string>()

  const rebuild = (state: AppState, keys: string[]): void => {
    // The view and content facts are this window's: read them back out of what it saves.
    const rebuilt = new Set(keys)
    const own = splitWorkspaceSessionByHost(buildWorkspaceSessionPayload(state), (key) =>
      rebuilt.has(key) ? LOCAL_EXECUTION_HOST_ID : OTHER_WORKSPACES
    )[LOCAL_EXECUTION_HOST_ID]!
    const { facts, desktopView } = loadWorkspaceLayoutWithoutReport(
      LOCAL_EXECUTION_HOST_ID,
      own,
      nameBasedLoadContext()
    )
    const heldFiles = new Set(state.openFiles.map((file) => `${file.worktreeId}\0${file.id}`))
    const built = buildLayoutFrameSlices({
      layouts: Object.fromEntries(keys.map((key) => [key, cache[key]!])),
      facts,
      view: desktopView,
      holdsEditorFile: (worktreeId, fileId) => heldFiles.has(`${worktreeId}\0${fileId}`)
    })
    const patch = buildLayoutFrameStorePatch(
      state,
      built,
      keys,
      isTabPaneTreeHeld,
      takeTabRowFields,
      HELD_DRAWN_TABS
    )
    if (Object.keys(patch).length > 0) {
      store.setState(patch)
    }
  }

  // Pane trees show at once; only a tab the window's own pane command holds waits.
  const showPaneTrees = (state: AppState, drawn: (key: string) => boolean): void => {
    let layouts = state.terminalLayoutsByTabId
    const waiting = new Set<string>()
    for (const key of paneTreeKeys) {
      const layout = cache[key]
      if (!layout || !drawn(key)) {
        continue
      }
      for (const tab of layout.tabs) {
        const root = tab.terminal?.root
        const current = root ? layouts[tab.entityId] : undefined
        if (!root || !current) {
          continue
        }
        if (isTabPaneTreeHeld(tab.entityId)) {
          waiting.add(key)
        } else if (stableJson(current.root) !== stableJson(root)) {
          layouts = { ...layouts, [tab.entityId]: { ...current, root } }
        }
      }
    }
    paneTreeKeys = waiting
    const patch = terminalLayoutsPatch(state, layouts)
    if (Object.keys(patch).length > 0) {
      store.setState(patch)
    }
  }

  const flush = (): void => {
    flushQueued = false
    if (!live) {
      return
    }
    const state = store.getState()
    const drawn = framesDrawWorkspace(state)
    const nextShown: Record<string, PublishedWorkspaceLayout> = {}
    const structural: string[] = []
    const titleUpdates: TerminalTabTitleUpdate[] = []
    for (const [key, layout] of Object.entries(cache)) {
      const previous = shown[key]
      if (layout === previous || !drawn(key)) {
        if (previous) {
          nextShown[key] = previous
        }
        continue
      }
      // Against the store, not `shown`: a held frame leaves `shown` behind the pane trees drawn since.
      paneTreeKeys.add(key)
      if (previous && structureJson(previous) === structureJson(layout)) {
        titleUpdates.push(
          ...liveTitleUpdates(
            previous,
            layout,
            (tabId) => state.terminalLayoutsByTabId[tabId]?.activeLeafId
          )
        )
        nextShown[key] = layout
      } else {
        structural.push(key)
        nextShown[key] = layout
      }
    }
    // A workspace main stopped publishing keeps what the window shows; main has nothing to say.
    shown = nextShown
    if (structural.length > 0) {
      rebuild(state, structural)
    }
    if (titleUpdates.length > 0) {
      store.getState().updateTabTitles(titleUpdates)
    }
    // A closed stream's cache is frozen: the window draws its own answers then.
    if (streamOpen && paneTreeKeys.size > 0) {
      showPaneTrees(store.getState(), framesDrawWorkspace(store.getState()))
    }
  }

  const scheduleFlush = (): void => {
    if (live && !flushQueued) {
      flushQueued = true
      // Coalesces the frames of one task.
      queueMicrotask(flush)
    }
  }

  beginLayoutFramePositions()
  const stream = subscribeRuntimeLayout(
    { kind: 'local' },
    {},
    (frame) => {
      cache = applyLayoutFrame(cache, frame)
      if (frame.type === 'snapshot') {
        // A reopened stream's snapshot redraws every workspace: the window drew alone meanwhile.
        if (snapshotReceived) {
          shown = {}
        }
        snapshotReceived = true
        live = started
      }
      scheduleFlush()
    },
    (status) => {
      if (status.state === 'lost' || status.state === 'refused') {
        console.warn('[layout-owner] layout stream stopped:', status)
      }
      if (status.state === 'connecting' && !streamOpen) {
        // The local stream reopens after a loss; replies wait for its frames again.
        streamOpen = true
        beginLayoutFramePositions()
      } else if (status.state !== 'connecting' && status.state !== 'live') {
        streamOpen = false
        endLayoutFramePositions()
      }
    },
    // After the frame's flush. A held tab may still show as the window drew it, so a waiting reply
    // checks the store rather than assume the frame shows.
    (seq) => queueMicrotask(() => streamOpen && noteLayoutFramePosition(seq))
  )
  // A released tab shows main's copy: its workspaces draw from the cache again.
  const stopHeldTabsListener = onDrawnTabsRedraw((workspaces) => {
    if (!streamOpen) {
      return
    }
    for (const key of workspaces) {
      delete shown[key]
    }
    scheduleFlush()
  })
  // Against the store: the window may have drawn over main's tree for this tab since.
  const stopReleaseListener = onTabPaneTreeRedraw((tabId) => {
    // A closed stream's cache is frozen: the window draws its own answers then.
    if (!streamOpen) {
      return
    }
    for (const [key, layout] of Object.entries(cache)) {
      if (layout.tabs.some((tab) => tab.entityId === tabId)) {
        paneTreeKeys.add(key)
      }
    }
    scheduleFlush()
  })

  return {
    start: () => {
      started = true
      // Before its snapshot, the snapshot starts it; a stream that ends first leaves restore's.
      live = snapshotReceived
      // A re-run restore rebuilt the slices, so every workspace is shown again.
      shown = {}
      flush()
    },
    close: () => {
      live = false
      stopHeldTabsListener()
      stopReleaseListener()
      stream.close()
    },
    // Only a pane flush draws: the same workspaces it shows.
    holdsTerminalPane: (worktreeId, { tabId, leafId, ptyId }) =>
      framesDrawWorkspace(store.getState())(worktreeId) &&
      (cache[worktreeId]?.tabs.some(
        (tab) =>
          tab.entityId === tabId &&
          (tab.terminal?.panes.some((pane) => pane.leafId === leafId && pane.ptyId === ptyId) ??
            false)
      ) ??
        false),
    // A closed stream's cache is frozen: main may have closed the tab since.
    terminalTab: (worktreeId, tabId) =>
      streamOpen
        ? cache[worktreeId]?.tabs.find((tab) => tab.kind === 'terminal' && tab.entityId === tabId)
        : undefined
  }
}

const HELD_DRAWN_TABS = { isTabHeld: isDrawnTabHeld, isGroupLayoutHeld: isDrawnGroupLayoutHeld }

let startupFrames: WorkspaceLayoutFrameSync | null = null

/** After restore: the window's one layout stream shows the frames' workspaces from now on. */
export function showStartupLayoutFrames(): void {
  // Kept for the document's life: a local stream ends only with main, and a re-run boot reuses it.
  if (!startupFrames) {
    startupFrames = openWorkspaceLayoutFrameSync(useAppStore)
    provideLayoutFrameTerminalPanes(startupFrames)
  }
  startupFrames.start()
}
