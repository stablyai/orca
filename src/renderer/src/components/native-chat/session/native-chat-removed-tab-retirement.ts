import {
  chatPaneAddressTabId,
  chatPaneKey
} from '../../../../../shared/agent-session/view/structured-agent-session-projection'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { forgetDirectlyOpenedChat } from '@/runtime/web-session-tabs-sync/tracking/directly-opened-chat-tabs'
import { retireNativeChatDraftPosition } from '../drafts/native-chat-composer-draft-memory'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import { retireNativeChatSubagentViews } from '../subagents/native-chat-open-subagent'
import { releaseRemovedChatTabsLater } from './native-chat-removed-tab-releaser'
import { chatTabsShowingConversation } from './status/structured-agent-session-tabs'

type TabsByWorktree = Record<string, Tab[]>

/** Retires the tab's draft position and closes the sheet on loss of the last view. */
export function retireNativeChatTab(tab: Tab, nextTabsByWorktree: TabsByWorktree): void {
  const host = parseExecutionHostId(tab.executionHostId)
  if (host?.kind === 'runtime') {
    forgetDirectlyOpenedChat(host.environmentId, tab.worktreeId, tab.entityId, tab.id)
  }
  retireNativeChatDraftPosition(
    readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)),
    tab.id
  )
  const showing = chatTabsShowingConversation(nextTabsByWorktree, chatPaneKey(tab.entityId))
  if (showing[Symbol.iterator]().next().done) {
    retireNativeChatSubagentViews(chatPaneAddressTabId(tab.entityId))
  }
}

export function retireRemovedNativeChatTabs(
  previousTabsByWorktree: TabsByWorktree,
  nextTabsByWorktree: TabsByWorktree,
  worktreeId: string
): void {
  const before = previousTabsByWorktree[worktreeId]
  const after = nextTabsByWorktree[worktreeId]
  if (before === after || !before?.length) {
    return
  }
  const remaining = new Map((after ?? []).map((tab) => [tab.id, tab]))
  const removed: Tab[] = []
  for (const tab of before) {
    const next = remaining.get(tab.id)
    if (
      tab.contentType === 'agent-session' &&
      (next?.contentType !== tab.contentType ||
        next.entityId !== tab.entityId ||
        next.executionHostId !== tab.executionHostId)
    ) {
      retireNativeChatTab(tab, nextTabsByWorktree)
      if (!next) {
        removed.push(tab)
      }
    }
  }
  releaseRemovedChatTabsLater(removed)
}
