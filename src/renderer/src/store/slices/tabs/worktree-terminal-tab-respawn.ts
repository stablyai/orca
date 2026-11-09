import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { getTerminalActivationSpawnSuppression } from '../../terminals/terminal-activation-spawn-suppression'
import {
  annotateRecordReplacement,
  annotateTabBucketReplacement,
  replaceTabBuckets
} from '../../keyed-record-transitions'

/**
 * Tags a worktree's wakeable terminal tabs for an activation spawn, optionally bumping their
 * generation so dead panes remount.
 */
export function markWorktreeTabsForActivationSpawn(
  s: AppState,
  worktreeId: string,
  options: { isWakeable: (tab: TerminalTab) => boolean; bumpGeneration: boolean }
): Pick<AppState, 'tabsByWorktree'> {
  const { isWakeable, bumpGeneration } = options
  return {
    tabsByWorktree: replaceTabBuckets(s.tabsByWorktree, [
      [
        worktreeId,
        (s.tabsByWorktree[worktreeId] ?? []).map((tab) =>
          !isWakeable(tab)
            ? tab
            : {
                ...tab,
                ...(bumpGeneration ? { generation: (tab.generation ?? 0) + 1 } : {}),
                // Why: slept terminal remount/spawn is click-driven wake work; tag its PTY updates so they don't reshuffle Recent.
                pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                  s.terminalLayoutsByTabId[tab.id]
                )
              }
        )
      ]
    ])
  }
}

/** Detaches terminal tabs from their PTYs, leaving the tabs in place to respawn. */
export function unbindTerminalTabPtys(
  s: AppState,
  tabIds: ReadonlySet<string>
): Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'> {
  let nextTabsByWorktree = s.tabsByWorktree
  const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
  const unboundTabIds: string[] = []
  const changedWorkspaces: string[] = []
  for (const [worktreeId, tabs] of Object.entries(s.tabsByWorktree)) {
    let nextTabs = tabs
    for (const [index, tab] of tabs.entries()) {
      if (!tabIds.has(tab.id)) {
        continue
      }
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      const { pendingActivationSpawn: _pendingActivationSpawn, ...tabWithoutActivationSpawn } = tab
      void _pendingActivationSpawn
      nextTabs[index] = { ...tabWithoutActivationSpawn, ptyId: null }
      nextPtyIdsByTabId[tab.id] = []
      unboundTabIds.push(tab.id)
    }
    if (nextTabs !== tabs) {
      if (nextTabsByWorktree === s.tabsByWorktree) {
        nextTabsByWorktree = { ...nextTabsByWorktree }
      }
      nextTabsByWorktree[worktreeId] = nextTabs
      changedWorkspaces.push(worktreeId)
    }
  }
  return {
    tabsByWorktree: annotateTabBucketReplacement(
      s.tabsByWorktree,
      nextTabsByWorktree,
      changedWorkspaces
    ),
    ptyIdsByTabId: annotateRecordReplacement(s.ptyIdsByTabId, nextPtyIdsByTabId, unboundTabIds)
  }
}
