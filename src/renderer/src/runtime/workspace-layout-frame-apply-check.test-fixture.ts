// The window's frame-apply check for one test's life: after every flush, the store must show what
// the full build (the window's view and facts read back through its save and the Loader) shows
// for the same cache and the store as the flush found it. Mirrors main's model check.

import { stableJson } from '../../../shared/workspace-layout/workspace-layout-load-report'
import { isTabPaneTreeHeld } from './layout-owner-pane-intents'
import {
  observeLayoutFrameApply,
  type LayoutFrameApplyObservation
} from './workspace-layout-frame-apply-observer'
import { fullLayoutFrameBuildPatch } from './workspace-layout-frame-builds'
import type { LayoutFrameSlices } from '@/store/workspace-layout-frame-slices'
import type { AppState } from '@/store/types'

const FRAME_SLICES: readonly (keyof LayoutFrameSlices)[] = [
  'tabsByWorktree',
  'terminalLayoutsByTabId',
  'activeTabIdByWorktree',
  'unifiedTabsByWorktree',
  'groupsByWorktree',
  'activeGroupIdByWorktree',
  'layoutByWorktree',
  'openFiles',
  'editorDrafts',
  'markdownFrontmatterVisible',
  'activeFileIdByWorktree',
  'browserTabsByWorktree',
  'browserPagesByWorkspace',
  'remoteBrowserPageHandlesByPageId',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree'
]

/** The slices' records of `keys` alone: each workspace's entries, and its tabs', files' and pages'. */
function recordsOf(state: AppState, keys: readonly string[]): Record<string, unknown> {
  const keySet = new Set(keys)
  const byKey = <T>(map: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([key]) => keySet.has(key)))
  const tabIds = new Set(keys.flatMap((key) => (state.tabsByWorktree[key] ?? []).map((t) => t.id)))
  const files = state.openFiles.filter((file) => keySet.has(file.worktreeId))
  const fileIds = new Set(files.map((file) => file.id))
  const browserTabIds = new Set(
    keys.flatMap((key) => (state.browserTabsByWorktree[key] ?? []).map((tab) => tab.id))
  )
  const pageIds = new Set(
    [...browserTabIds].flatMap((id) => (state.browserPagesByWorkspace[id] ?? []).map((p) => p.id))
  )
  const only = <T>(map: Record<string, T>, ids: ReadonlySet<string>): Record<string, T> =>
    Object.fromEntries(Object.entries(map).filter(([id]) => ids.has(id)))
  return {
    tabsByWorktree: byKey(state.tabsByWorktree),
    terminalLayoutsByTabId: only(state.terminalLayoutsByTabId, tabIds),
    activeTabIdByWorktree: byKey(state.activeTabIdByWorktree),
    unifiedTabsByWorktree: byKey(state.unifiedTabsByWorktree),
    groupsByWorktree: byKey(state.groupsByWorktree),
    activeGroupIdByWorktree: byKey(state.activeGroupIdByWorktree),
    layoutByWorktree: byKey(state.layoutByWorktree),
    openFiles: files,
    editorDrafts: only(state.editorDrafts, fileIds),
    markdownFrontmatterVisible: only(state.markdownFrontmatterVisible, fileIds),
    activeFileIdByWorktree: byKey(state.activeFileIdByWorktree),
    browserTabsByWorktree: byKey(state.browserTabsByWorktree),
    browserPagesByWorkspace: only(state.browserPagesByWorkspace, browserTabIds),
    remoteBrowserPageHandlesByPageId: only(state.remoteBrowserPageHandlesByPageId, pageIds),
    activeBrowserTabIdByWorktree: byKey(state.activeBrowserTabIdByWorktree),
    activeTabTypeByWorktree: byKey(state.activeTabTypeByWorktree)
  }
}

/**
 * Empty when the flush left the store as the full build of its workspaces leaves it. A workspace
 * the flush built in full ran the reference itself (and a second run mints other ids for a new
 * page), so a flush that built one in full is checked on its other workspaces' records.
 */
export function layoutFrameApplyErrors({
  before,
  after,
  cache,
  changed,
  fullBuilt,
  rowFieldsTaken,
  held,
  selectTakenMovedTabs
}: LayoutFrameApplyObservation): string[] {
  const keys = changed.filter((key) => key in cache && !fullBuilt.includes(key))
  if (keys.length === 0) {
    return []
  }
  // The moved tabs the flush selected are selected the same way here, so a wrong one still shows.
  const built = selectTakenMovedTabs({
    ...before,
    ...fullLayoutFrameBuildPatch(before, cache, keys, {
      keepsTerminalLayout: isTabPaneTreeHeld,
      newRowFields: (tabId) => rowFieldsTaken.get(tabId) ?? null,
      held
    })
  })
  const whole = fullBuilt.length === 0
  const expected: Record<string, unknown> = whole ? { ...built } : recordsOf(built, keys)
  const shown: Record<string, unknown> = whole ? { ...after } : recordsOf(after, keys)
  return FRAME_SLICES.flatMap((slice) =>
    stableJson(shown[slice]) === stableJson(expected[slice])
      ? []
      : [firstDifference(slice, shown[slice], expected[slice])]
  )
}

/** For a shared transport with no test of its own to report to: the flush itself fails. */
export function throwLayoutFrameApplyErrors(observation: LayoutFrameApplyObservation): void {
  const errors = layoutFrameApplyErrors(observation)
  if (errors.length > 0) {
    throw new Error(`layout frame apply differs from the full build:\n${errors.join('\n')}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The first path where the store and the full build differ, with both values there. */
function firstDifference(path: string, shown: unknown, built: unknown): string {
  if (isObject(shown) && isObject(built)) {
    for (const key of new Set([...Object.keys(shown), ...Object.keys(built)])) {
      if (stableJson(shown[key]) !== stableJson(built[key])) {
        return firstDifference(`${path}.${key}`, shown[key], built[key])
      }
    }
  }
  return `${path}: store ${stableJson(shown)} != full build ${stableJson(built)}`
}

export function installLayoutFrameApplyCheck(): {
  /** Every mismatch found, flush by flush. */
  failures: string[]
  /** Workspaces built in full and from the store's view, in flush order. */
  fullBuilt: string[]
  workspaceBuilt: string[]
  checked: () => number
  /** Forgets the builds so far, such as startup's. */
  forgetBuilds: () => void
  uninstall: () => void
} {
  const failures: string[] = []
  const fullBuilt: string[] = []
  const workspaceBuilt: string[] = []
  let checked = 0
  observeLayoutFrameApply((observation) => {
    checked += 1
    fullBuilt.push(...observation.fullBuilt)
    workspaceBuilt.push(...observation.workspaceBuilt)
    failures.push(...layoutFrameApplyErrors(observation))
  })
  return {
    failures,
    fullBuilt,
    workspaceBuilt,
    checked: () => checked,
    forgetBuilds: () => {
      fullBuilt.length = 0
      workspaceBuilt.length = 0
    },
    uninstall: () => observeLayoutFrameApply(null)
  }
}
