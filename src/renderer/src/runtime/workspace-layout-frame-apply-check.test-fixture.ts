// After each window frame flush, compare store slices with the full save/Loader build using identical cache/view/facts, like main’s model check.

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

/** Check only workspaces not fully built by the flush: full builds already ran the reference, and replay can mint different page IDs. */
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

export function throwLayoutFrameApplyErrors(observation: LayoutFrameApplyObservation): void {
  const errors = layoutFrameApplyErrors(observation)
  if (errors.length > 0) {
    throw new Error(`layout frame apply differs from the full build:\n${errors.join('\n')}`)
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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
  failures: string[]
  /** Workspaces built in full and from the store's view, in flush order. */
  fullBuilt: string[]
  workspaceBuilt: string[]
  checked: () => number
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
