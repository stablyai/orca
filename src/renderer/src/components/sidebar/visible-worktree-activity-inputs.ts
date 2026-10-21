import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import { createWorktreeTabBucketProjection } from '@/lib/worktree-tab-bucket-projection'

export type TerminalActivityTab = Pick<TerminalTab, 'id'>
export type BrowserActivityTab = Pick<BrowserWorkspace, 'id'>

export function createVisibleWorktreeTerminalActivityProjection(
  onInspectBucket?: (worktreeId: string) => void
) {
  return createWorktreeTabBucketProjection<TerminalTab, TerminalActivityTab>({
    projectTab: (tab) => ({ id: tab.id }),
    isSameProjectedTab: (previousTab, nextTab) => previousTab.id === nextTab.id,
    onInspectBucket
  })
}

const terminalProjection = createVisibleWorktreeTerminalActivityProjection()

export function getVisibleWorktreeTerminalActivityTabs(
  tabsByWorktree: Record<string, TerminalTab[]>
): Record<string, TerminalActivityTab[]> {
  return terminalProjection.project(tabsByWorktree)
}

const browserProjection = createWorktreeTabBucketProjection<BrowserWorkspace, BrowserActivityTab>({
  projectTab: (tab) => ({ id: tab.id }),
  isSameProjectedTab: (previousTab, nextTab) => previousTab.id === nextTab.id
})

export function getVisibleWorktreeBrowserActivityTabs(
  browserTabsByWorktree: Record<string, BrowserWorkspace[]>
): Record<string, BrowserActivityTab[]> {
  return browserProjection.project(browserTabsByWorktree)
}

export const EMPTY_STRUCTURED_CHAT_WORKTREE_IDS: ReadonlySet<string> = new Set()
const structuredChatWorktreeIds = new WeakMap<Record<string, Tab[]>, ReadonlySet<string>>()

/**
 * Worktree ids holding a structured chat tab.
 *
 * Why existence rather than a live provider child: that child is held only while the chat's pane is
 * visible and is evicted after it sits idle unheld, so keying on it would flip a workspace to sleeping
 * after any worktree switch and report a process recycle the user never sees. The chat itself — its
 * transcript, and its ability to take the next send — outlives the child.
 */
export function getWorktreeIdsWithStructuredChat(
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined
): ReadonlySet<string> {
  if (!unifiedTabsByWorktree) {
    return EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
  }
  // Keyed on the snapshot, like the tab projection it reads: zustand re-runs every mounted card's
  // selector on each store write, and this is a whole-store scan.
  const cached = structuredChatWorktreeIds.get(unifiedTabsByWorktree)
  if (cached) {
    return cached
  }
  const worktreeIds = new Set(
    getStructuredAgentSessionTabs(unifiedTabsByWorktree).map((tab) => tab.worktreeId)
  )
  structuredChatWorktreeIds.set(unifiedTabsByWorktree, worktreeIds)
  return worktreeIds
}

export function getStructuredChatWorktreeIds(
  showSleepingWorkspaces: boolean,
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined
): ReadonlySet<string> {
  return showSleepingWorkspaces
    ? EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
    : getWorktreeIdsWithStructuredChat(unifiedTabsByWorktree)
}
