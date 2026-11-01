// The chat window is a tail. Tasks and plans written earlier still belong on the pill.

import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot
} from '../../agent-session/journal/agent-session-journal-types'
import { isRootAgentJournalItem } from '../../agent-session/journal/agent-session-journal-producer'
import { CODEX_PLAN_UPDATED_FRAME_KIND } from '../native-chat-provider-frame-summary'
import { projectStructuredItemsToNativeChat } from '../../structured-agent-session-projection'
import { latestNativeChatTaskSeed } from './native-chat-activity'
import type { NativeChatTaskSeedList } from './native-chat-claude-task-updates'
import { nativeChatTaskListTool } from './native-chat-task-list'

const CLAUDE_TASK_TOOLS = new Set(['taskcreate', 'taskupdate', 'tasklist', 'taskget'])

const taskSeedCache = new WeakMap<
  AgentJournalSnapshot,
  { key: string; taskList: NativeChatTaskSeedList | null }
>()

function feedsTaskList(item: AgentJournalRenderItem): boolean {
  if (!isRootAgentJournalItem(item)) {
    return false
  }
  const body = item.body
  if (body.kind === 'tool-call') {
    const name = body.name.trim().toLowerCase()
    return CLAUDE_TASK_TOOLS.has(name) || nativeChatTaskListTool(body.name) !== null
  }
  if (body.kind !== 'status' || body.turnLifecycle) {
    return false
  }
  return (
    body.presentation === 'plan-document' ||
    body.providerFrame?.kind === CODEX_PLAN_UPDATED_FRAME_KIND
  )
}

/** Root-agent tasks and plans from a journal, including rows the page does not carry. */
export function nativeChatTaskSeedFromJournal(
  items: readonly AgentJournalRenderItem[]
): NativeChatTaskSeedList | null {
  const relevant = items.filter(feedsTaskList)
  if (relevant.length === 0) {
    return null
  }
  return latestNativeChatTaskSeed(projectStructuredItemsToNativeChat(relevant))
}

/** Omit the field when the journal has no tasks, so older page snapshots stay unchanged. */
export function historyPageTaskList(
  snapshot: AgentJournalSnapshot
): { taskList: NativeChatTaskSeedList } | Record<string, never> {
  const last = snapshot.items.at(-1)
  const key = `${snapshot.items.length}:${snapshot.cursor.sequence}:${last?.sequence ?? 0}:${last?.revision ?? 0}`
  const cached = taskSeedCache.get(snapshot)
  const taskList =
    cached?.key === key ? cached.taskList : nativeChatTaskSeedFromJournal(snapshot.items)
  if (cached?.key !== key) {
    taskSeedCache.set(snapshot, { key, taskList })
  }
  return taskList ? { taskList } : {}
}
