import type { AppState } from '../../types'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { getTerminalActivationSpawnSuppression } from '../../terminals/terminal-activation-spawn-suppression'
import {
  replaceRecordEntries,
  replaceTabBuckets,
  tabBucketDraft
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
  const tabs = tabBucketDraft(s.tabsByWorktree)
  const ptyIdOperations: [string, string[]][] = []
  for (const [worktreeId, worktreeTabs] of Object.entries(s.tabsByWorktree)) {
    let nextTabs = worktreeTabs
    for (const [index, tab] of worktreeTabs.entries()) {
      if (!tabIds.has(tab.id)) {
        continue
      }
      if (nextTabs === worktreeTabs) {
        nextTabs = [...worktreeTabs]
      }
      const { pendingActivationSpawn: _pendingActivationSpawn, ...tabWithoutActivationSpawn } = tab
      void _pendingActivationSpawn
      nextTabs[index] = { ...tabWithoutActivationSpawn, ptyId: null }
      ptyIdOperations.push([tab.id, []])
    }
    tabs.set(worktreeId, nextTabs)
  }
  return {
    tabsByWorktree: tabs.finish(),
    ptyIdsByTabId: replaceRecordEntries(s.ptyIdsByTabId, ptyIdOperations)
  }
}
