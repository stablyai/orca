import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { retireNativeChatDraftPosition } from '../drafts/native-chat-composer-draft-memory'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import { retireNativeChatSubagentViews } from '../subagents/native-chat-open-subagent'
import { chatPaneAddressTabId } from '../../../../../shared/agent-session/view/structured-agent-session-projection'

/** A chat tab's death retires its pane-only UI: the draft's unsatisfied position (never the draft) and any open subagent view. */
export function retireRemovedNativeChatTabs(before: readonly Tab[], after: readonly Tab[]): void {
  if (before === after) {
    return
  }
  const remaining = new Map(after.map((tab) => [tab.id, tab]))
  let shownSessions: Set<string> | undefined
  for (const tab of before) {
    const next = remaining.get(tab.id)
    if (
      tab.contentType === 'agent-session' &&
      (next?.contentType !== tab.contentType ||
        next.entityId !== tab.entityId ||
        next.executionHostId !== tab.executionHostId)
    ) {
      retireNativeChatDraftPosition(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)),
        tab.id
      )
      // Views follow the conversation; another tab still showing it keeps them.
      shownSessions ??= new Set(
        after.flatMap((other) => (other.contentType === 'agent-session' ? [other.entityId] : []))
      )
      if (!shownSessions.has(tab.entityId)) {
        retireNativeChatSubagentViews(chatPaneAddressTabId(tab.entityId))
      }
    }
  }
}
