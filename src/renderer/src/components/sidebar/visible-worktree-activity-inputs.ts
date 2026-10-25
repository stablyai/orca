import type { BrowserWorkspace } from '../../../../shared/browser-workspace-types'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { getStructuredAgentSessionTabs } from '@/components/native-chat/structured-agent-session-tabs'
import { createWorktreeTabBucketProjection } from '@/lib/worktree-tab-bucket-projection'
import type { StructuredChatSleptAtByPaneKey } from '@/store/slices/structured-chat-slept-at'

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
const EMPTY_SLEPT_CHATS: StructuredChatSleptAtByPaneKey = {}
const structuredChatWorktreeIds = new WeakMap<
  Record<string, Tab[]>,
  WeakMap<StructuredChatSleptAtByPaneKey, ReadonlySet<string>>
>()

/** Only explicit Sleep marks rest a structured chat; idle child teardown or restart must not hide its workspace. */
export function getWorktreeIdsWithStructuredChat(
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined,
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey = EMPTY_SLEPT_CHATS
): ReadonlySet<string> {
  if (!unifiedTabsByWorktree) {
    return EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
  }
  // Cache whole-store scans by snapshot because every card selector runs on each store write.
  const cached = structuredChatWorktreeIds
    .get(unifiedTabsByWorktree)
    ?.get(structuredChatSleptAtByPaneKey)
  if (cached) {
    return cached
  }
  const worktreeIds = new Set(
    getStructuredAgentSessionTabs(unifiedTabsByWorktree)
      .filter(
        (tab) =>
          structuredChatSleptAtByPaneKey[structuredAgentSessionPaneKey(tab.id, tab.entityId)] ===
          null
      )
      .map((tab) => tab.worktreeId)
  )
  const bySleptAt = structuredChatWorktreeIds.get(unifiedTabsByWorktree) ?? new WeakMap()
  bySleptAt.set(structuredChatSleptAtByPaneKey, worktreeIds)
  structuredChatWorktreeIds.set(unifiedTabsByWorktree, bySleptAt)
  return worktreeIds
}

export function getStructuredChatWorktreeIds(
  showSleepingWorkspaces: boolean,
  unifiedTabsByWorktree: Record<string, Tab[]> | null | undefined,
  structuredChatSleptAtByPaneKey: StructuredChatSleptAtByPaneKey = EMPTY_SLEPT_CHATS
): ReadonlySet<string> {
  return showSleepingWorkspaces
    ? EMPTY_STRUCTURED_CHAT_WORKTREE_IDS
    : getWorktreeIdsWithStructuredChat(unifiedTabsByWorktree, structuredChatSleptAtByPaneKey)
}
