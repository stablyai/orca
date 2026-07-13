import type { AppState } from '@/store/types'
import {
  SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT,
  type SetWorktreeTerminalAutoScrollDetail
} from '@/constants/terminal'
import { collectDurableTerminalLayoutLeafIds } from '@/components/terminal-pane/terminal-layout-leaf-ids'
import {
  getTerminalScrollIntentKindByKey,
  setTerminalScrollIntentKindByKey
} from '@/lib/pane-manager/terminal-scroll-intent'

type WorktreeTerminalAutoScrollState = Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>

function getWorktreeTerminalLeafIds(
  state: WorktreeTerminalAutoScrollState,
  worktreeIds: readonly string[]
): { leafIds: string[]; worktreeIds: string[] } {
  const uniqueWorktreeIds = [...new Set(worktreeIds.filter(Boolean))]
  const leafIds = new Set<string>()
  for (const worktreeId of uniqueWorktreeIds) {
    for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
      for (const leafId of collectDurableTerminalLayoutLeafIds(
        state.terminalLayoutsByTabId[tab.id]
      )) {
        leafIds.add(leafId)
      }
    }
  }
  return { leafIds: [...leafIds], worktreeIds: uniqueWorktreeIds }
}

export function areWorktreeTerminalsFollowingOutput(
  state: WorktreeTerminalAutoScrollState,
  worktreeIds: readonly string[]
): boolean {
  const { leafIds } = getWorktreeTerminalLeafIds(state, worktreeIds)
  return (
    leafIds.length > 0 &&
    leafIds.every((leafId) => getTerminalScrollIntentKindByKey(leafId) === 'followOutput')
  )
}

export function setWorktreeTerminalAutoScroll(
  state: WorktreeTerminalAutoScrollState,
  worktreeIds: readonly string[],
  enabled: boolean
): void {
  const targets = getWorktreeTerminalLeafIds(state, worktreeIds)
  // Why: parked scroll intent is keyed by durable leaf ID, so hidden panes
  // consume this request when their terminal instance mounts again.
  for (const leafId of targets.leafIds) {
    setTerminalScrollIntentKindByKey(leafId, enabled ? 'followOutput' : 'pinnedViewport')
  }
  window.dispatchEvent(
    new CustomEvent<SetWorktreeTerminalAutoScrollDetail>(SET_WORKTREE_TERMINAL_AUTO_SCROLL_EVENT, {
      detail: { worktreeIds: targets.worktreeIds, enabled }
    })
  )
}
