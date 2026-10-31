// Layout-owner windows draw main’s locally owned, held workspaces; paired servers remain mirror-owned. Local tab changes stay drawn until main answers (layout-owner-drawn-tab-holds). Records frames apply binding/title deltas directly and rebuild other changed workspaces from store. Startup/reopen/new/whole workspaces use full save/Loader builds (E2a/E2b).

import { showFramePatch, withMovedTabsSelected } from '@/store/slices/tabs/moved-tab-selection'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import { applyLayoutFrame, EMPTY_WORKSPACE_LAYOUT_CACHE } from '@/store/workspace-layout-cache'
import type { WorkspaceLayoutCache } from '@/store/workspace-layout-cache'
import { terminalLayoutsPatch } from '@/store/workspace-layout-frame-store-patch'
import {
  layoutHoldsBoundPane,
  onWorkspaceStartsDrawing
} from './workspace-layout-frame-drawn-workspaces'
import type { TerminalTabTitleUpdate } from '@/store/slices/terminal-tab-title-batch'
import type { WorkspaceLayoutChangeFrame } from '../../../shared/workspace-layout/workspace-layout-stream-frames'
import { liveTitleUpdates } from './workspace-layout-frame-changes'
import { terminalLayoutsWithFramePaneTrees } from './workspace-layout-frame-pane-trees'
import { framePaneFactsShown, showFramePaneStarts } from './workspace-layout-frame-pane-starts'
import {
  layoutFrameFlushPatch,
  type LayoutFrameBuildHolds,
  type LayoutFrameBuildPatch
} from './workspace-layout-frame-builds'
import { eitherHeld } from '@/store/workspace-layout-frame-held-tabs'
import { heldTabGroupFocus } from './held-tab-group-follow'
import { shownContentRekeyPatch } from './layout-owner-content-rekeys'
import { provideLayoutFrameWorkspaces } from './layout-frame-workspaces'
import {
  notePendingRecordsFrame,
  pendingWorkspaceChanges,
  type PendingWorkspaceChanges
} from './workspace-layout-frame-pending'
import { layoutFrameApplyObserver } from './workspace-layout-frame-apply-observer'
import {
  provideLayoutFrameTerminalPanes,
  type LayoutFrameTerminalQueries
} from './layout-frame-terminal-panes'
import {
  isTabPaneTreeHeld,
  onTabPaneTreeRedraw,
  takeTabRowFields,
  type MovedTabSelection
} from './layout-owner-pane-intents'
import {
  isDrawnGroupLayoutHeld,
  isDrawnTabHeld,
  onDrawnTabsRedraw
} from './layout-owner-drawn-tab-holds'
import {
  LOCAL_LAYOUT_FRAMES,
  openLayoutFrameStream,
  type LayoutFrameSource
} from './layout-frame-stream'

type FrameSyncStore = {
  getState: () => AppState
  setState: (patch: Partial<AppState>) => void
  subscribe: (listener: (state: AppState) => void) => () => void
}

export type WorkspaceLayoutFrameSync = LayoutFrameTerminalQueries & {
  /** Shows every workspace the frames own once the snapshot is in, then keeps them current. */
  start: () => void
  close: () => void
  /** A frame this window made from what it already holds (a paired server's new handles). */
  receive: (frame: WorkspaceLayoutChangeFrame) => void
  /** These workspaces have just started drawing from frames: each takes the full build. */
  redraw: (keys: Iterable<string>) => void
}

export function openWorkspaceLayoutFrameSync(
  store: FrameSyncStore,
  source: LayoutFrameSource = LOCAL_LAYOUT_FRAMES
): WorkspaceLayoutFrameSync {
  let cache: WorkspaceLayoutCache = EMPTY_WORKSPACE_LAYOUT_CACHE
  /** Workspaces the store shows from frames; any other the frames draw takes a full build. */
  const shown = new Set<string>()
  /** Workspace key → what its records frames changed since the last flush. */
  const pending = new Map<string, PendingWorkspaceChanges>()
  let started = false
  let live = false
  let snapshotReceived = false
  let flushQueued = false
  let streamOpen = true
  // Workspaces needing pane trees after a build or skipped held-tab update.
  let paneTreeKeys = new Set<string>()
  const paneStartsShown = framePaneFactsShown()

  /** The moved tabs' selections this flush's writes took. */
  let selectionsTaken: MovedTabSelection[] = []
  const show = (patch: LayoutFrameBuildPatch, rebuiltWorkspaces?: readonly string[]): void => {
    selectionsTaken.push(...showFramePatch(store, patch, rebuiltWorkspaces))
  }

  // Each change against the cache's copy it applies to, before the frame replaces it.
  const noteFrame = (before: WorkspaceLayoutCache, frame: WorkspaceLayoutChangeFrame): void => {
    switch (frame.type) {
      case 'snapshot':
        // A reopened stream's snapshot redraws every workspace: the window drew alone meanwhile.
        if (snapshotReceived) {
          shown.clear()
        }
        return
      case 'workspace':
      case 'removed':
        // An older host's whole workspace: only a full build shows it.
        shown.delete(frame.key)
        return
      case 'records':
        notePendingRecordsFrame(pending, shown, before, cache, frame)
    }
  }

  // Pane trees show at once; only a tab the window's own pane command holds waits.
  const showPaneTrees = (state: AppState): void => {
    const shownTrees = terminalLayoutsWithFramePaneTrees(
      state.terminalLayoutsByTabId,
      cache,
      paneTreeKeys,
      source.draws(state)
    )
    paneTreeKeys = shownTrees.waiting
    show(terminalLayoutsPatch(state, shownTrees.layouts))
  }

  const flush = (): void => {
    flushQueued = false
    selectionsTaken = []
    if (!live) {
      pending.clear()
      return
    }
    const state = store.getState()
    const drawn = source.draws(state)
    const rowFieldsTaken = new Map<string, Partial<TerminalTab>>()
    const holds: LayoutFrameBuildHolds = {
      ...FRAME_BUILD_HOLDS,
      held: eitherHeld(FRAME_BUILD_HOLDS.held, source.heldTabs),
      newRowFields: (tabId) => {
        const fields = takeTabRowFields(tabId)
        if (fields) {
          rowFieldsTaken.set(tabId, fields)
        }
        return fields
      }
    }
    const changed: string[] = []
    const fullBuilt: string[] = []
    const workspaceBuilt: string[] = []
    const rebound = new Map<string, ReadonlySet<string>>()
    const titleUpdates: TerminalTabTitleUpdate[] = []
    for (const [key, layout] of Object.entries(cache)) {
      const changes = pending.get(key)
      if (!drawn(key)) {
        // Frames the window did not draw: its next draw takes the full build.
        if (changes) {
          shown.delete(key)
        }
        continue
      }
      if (shown.has(key) && !changes) {
        continue
      }
      changed.push(key)
      if (!shown.has(key)) {
        fullBuilt.push(key)
      } else if (changes?.rebuild) {
        workspaceBuilt.push(key)
      } else if (changes) {
        titleUpdates.push(
          ...liveTitleUpdates(
            changes.titled,
            layout,
            (tabId) => state.terminalLayoutsByTabId[tabId]?.activeLeafId
          )
        )
        if (changes.rebound.size > 0) {
          rebound.set(key, changes.rebound)
        }
      }
    }
    pending.clear()
    // A workspace main stopped publishing keeps what the window shows; main has nothing to say.
    for (const key of shown) {
      if (!(key in cache)) {
        shown.delete(key)
      }
    }
    // One update: a move's or rename's content rekeys with the frame that shows it.
    const rekeyed = shownContentRekeyPatch(state, cache)
    const base: AppState = { ...state, ...rekeyed }
    const builtKeys = [...fullBuilt, ...workspaceBuilt]
    const patch = layoutFrameFlushPatch(base, cache, { fullBuilt, workspaceBuilt, rebound }, holds)
    show({ ...rekeyed, ...patch }, builtKeys)
    if (titleUpdates.length > 0) {
      store.getState().updateTabTitles(titleUpdates)
    }
    showFramePaneStarts(store, changed, cache, paneStartsShown)
    // Run after the apply check: the focus is the user's selection, not the frame's.
    const followHeldTabs = heldTabGroupFocus(base, store, builtKeys, holds.held)
    for (const key of builtKeys) {
      shown.add(key)
      // Against the store, not the frame: a held tab's tree may lag the pane trees drawn since.
      paneTreeKeys.add(key)
    }
    // Closed-stream cache is frozen: draw local command answers now; other changes wait for reopened snapshot.
    if (!streamOpen) {
      followHeldTabs()
      return
    }
    if (paneTreeKeys.size > 0) {
      showPaneTrees(store.getState())
    }
    layoutFrameApplyObserver()?.({
      before: base,
      after: store.getState(),
      cache,
      changed,
      fullBuilt,
      workspaceBuilt,
      rowFieldsTaken,
      held: holds.held,
      selectTakenMovedTabs: (state) => withMovedTabsSelected(state, selectionsTaken)
    })
    followHeldTabs()
  }

  const scheduleFlush = (): void => {
    if (live && !flushQueued) {
      flushQueued = true
      // Coalesces the frames of one task.
      queueMicrotask(flush)
    }
  }

  // A released tab shows main's copy: its workspace builds from the cache again.
  const rebuildWorkspaces = (keys: Iterable<string>): void => {
    for (const key of keys) {
      if (shown.has(key)) {
        pendingWorkspaceChanges(pending, key).rebuild = true
      }
    }
    scheduleFlush()
  }

  const receive = (frame: WorkspaceLayoutChangeFrame): void => {
    const before = cache
    cache = applyLayoutFrame(cache, frame)
    noteFrame(before, frame)
    if (frame.type === 'snapshot') {
      snapshotReceived = true
      live = started
    }
    scheduleFlush()
  }

  const stream = openLayoutFrameStream(source, receive, (open) => {
    streamOpen = open
  })
  const stopHeldTabsListener = onDrawnTabsRedraw((workspaces) => {
    if (streamOpen) {
      rebuildWorkspaces(workspaces)
    }
  })
  // Against the store: the window may have drawn over main's tree for this tab since.
  const stopReleaseListener = onTabPaneTreeRedraw((tabId) => {
    // Closed-stream cache is frozen: draw local command answers now; other changes wait for reopened snapshot.
    if (!streamOpen) {
      return
    }
    rebuildWorkspaces(
      Object.entries(cache).flatMap(([key, layout]) =>
        layout.tabs.some((tab) => tab.entityId === tabId) ? [key] : []
      )
    )
  })

  // Draw main-only workspace on first visit or activation seeds a duplicate instead of finding CLI-started tabs.
  const stopHeldWorkspacesListener = onWorkspaceStartsDrawing(
    store,
    source.draws,
    () => Object.keys(cache).filter((key) => !shown.has(key)),
    () => streamOpen && scheduleFlush()
  )

  let stopWorkspaceReader = (): void => {}
  return {
    start: () => {
      started = true
      // A closed stream's cache is frozen: main may have changed the workspace since.
      stopWorkspaceReader = provideLayoutFrameWorkspaces((worktreeId) =>
        streamOpen ? cache[worktreeId] : undefined
      )
      // Before its snapshot, the snapshot starts it; a stream that ends first leaves restore's.
      live = snapshotReceived
      // A re-run restore rebuilt the slices, so every workspace is shown again.
      shown.clear()
      flush()
    },
    receive,
    redraw: (keys) => {
      for (const key of keys) {
        shown.delete(key)
      }
      if (streamOpen) {
        scheduleFlush()
      }
    },
    close: () => {
      live = false
      stopWorkspaceReader()
      stopHeldWorkspacesListener()
      stopHeldTabsListener()
      stopReleaseListener()
      stream.close()
    },
    // Only a pane flush draws: the same workspaces it shows.
    holdsTerminalPane: (worktreeId, pane) =>
      source.draws(store.getState())(worktreeId) && layoutHoldsBoundPane(cache[worktreeId], pane),
    // A closed stream's cache is frozen: main may have closed the tab since.
    terminalTab: (worktreeId, tabId) =>
      streamOpen
        ? cache[worktreeId]?.tabs.find((tab) => tab.kind === 'terminal' && tab.entityId === tabId)
        : undefined
  }
}

const FRAME_BUILD_HOLDS: Omit<LayoutFrameBuildHolds, 'newRowFields'> = {
  keepsTerminalLayout: isTabPaneTreeHeld,
  held: { isTabHeld: isDrawnTabHeld, isGroupLayoutHeld: isDrawnGroupLayoutHeld }
}

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
