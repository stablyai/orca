import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { parseExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { forgetDirectlyOpenedChat } from '@/runtime/web-session-tabs-sync/tracking/directly-opened-chat-tabs'
import { retireNativeChatDraftPosition } from '../drafts/native-chat-composer-draft-memory'
import { readNativeChatComposerDraft } from '../drafts/native-chat-composer-draft-store'
import { structuredAgentSessionDraftScopeKey } from '../drafts/native-chat-draft-scope'
import { retireNativeChatSubagentViews } from '../subagents/native-chat-open-subagent'

/** A chat tab's death retires its pane-only UI: the draft's unsatisfied position (never the draft) and any open subagent view. */
export function retireRemovedNativeChatTabs(before: readonly Tab[], after: readonly Tab[]): void {
  if (before === after) {
    return
  }
  const remaining = new Map(after.map((tab) => [tab.id, tab]))
  for (const tab of before) {
    const next = remaining.get(tab.id)
    if (
      tab.contentType === 'agent-session' &&
      (next?.contentType !== tab.contentType ||
        next.entityId !== tab.entityId ||
        next.executionHostId !== tab.executionHostId)
    ) {
      const host = parseExecutionHostId(tab.executionHostId)
      if (host?.kind === 'runtime') {
        forgetDirectlyOpenedChat(host.environmentId, tab.worktreeId, tab.entityId, tab.id)
      }
      retireNativeChatDraftPosition(
        readNativeChatComposerDraft(structuredAgentSessionDraftScopeKey(tab.entityId)),
        tab.id
      )
      retireNativeChatSubagentViews(tab.id)
    }
  }
}
