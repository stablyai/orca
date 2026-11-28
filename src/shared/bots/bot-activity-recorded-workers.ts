// A bot chat's workers as the host records them, merged into the bot's Activity rows.
import {
  sessionWorkerAgentState,
  sessionWorkerIsRunning,
  type OrchestrationSessionWorker
} from '../orchestration-session-workers'
import type { AgentDotState } from '../agent-dot-state'
import { agentRowDotState } from '../agent-row-dot-state'
import { chatPaneKey } from '../agent-session/view/chat-pane-address'
import type {
  BotActivityInput,
  BotActivityOrigin,
  BotActivityStatus,
  BotWorkerRow,
  BotWorkerTool
} from './bot-activity-model'

/** A row's title is a line, never a whole prompt. */
export const BOT_ACTIVITY_TITLE_MAX = 200

/** What a worker waiting on a permission asks to run, only when its status says. */
export function botWorkerTool(
  entry: BotActivityStatus | null,
  dot: AgentDotState
): { tool?: BotWorkerTool } {
  return dot === 'permission' && entry?.toolName
    ? { tool: { name: entry.toolName, input: entry.toolInput ?? null } }
    : {}
}

export function clipActivityTitle(title: string): string {
  return title.length > BOT_ACTIVITY_TITLE_MAX
    ? `${title.slice(0, BOT_ACTIVITY_TITLE_MAX - 1)}…`
    : title
}

/** For clients without Crew's rules (the phone, the bot roll-up); the desktop draws the record itself.
 *  An open `ask` or gate is its coordinator's to answer, so it never reads as needing the owner. */
function recordedWorkerDot(worker: OrchestrationSessionWorker): AgentDotState {
  switch (worker.state) {
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'stopped':
      return 'interrupted'
    case 'unverifiable':
      return 'unverifiable'
    case 'working':
      return agentRowDotState(sessionWorkerAgentState(worker))
  }
}

/** The top section's "N running": rows whose agent works now, not every open one. */
export function workingWorkerRowCount(rows: readonly { dot: AgentDotState }[]): number {
  return rows.filter((row) => row.dot === 'working' || row.dot === 'monitoring').length
}

export function recordedWorkerRow(
  worker: OrchestrationSessionWorker,
  origin: BotActivityOrigin,
  paneKey: string | null
): BotWorkerRow {
  return {
    kind: 'worker',
    key: `worker:${worker.dispatchId}`,
    dispatchId: worker.dispatchId,
    title: clipActivityTitle(worker.title),
    dot: recordedWorkerDot(worker),
    origin,
    paneKey: paneKey ?? worker.paneKey,
    workspaceId: worker.worktreeId,
    at: worker.startedAt,
    worker
  }
}

/** An open worker keeps its row up top, idle or not; anything settled is history. */
export function workerRowIsRunning(row: BotWorkerRow): boolean {
  return row.worker
    ? sessionWorkerIsRunning(row.worker)
    : row.dot !== 'done' && row.dot !== 'failed'
}

/** The bot's recorded workers by dispatch, each credited to what started the chat or pane that created it. */
export function recordedWorkersByDispatch(
  input: Pick<BotActivityInput, 'sessions' | 'runs' | 'links' | 'recordedWorkers'>,
  originByPaneKey: ReadonlyMap<string, BotActivityOrigin>
): Map<string, { worker: OrchestrationSessionWorker; origin: BotActivityOrigin }> {
  const recorded = new Map<
    string,
    { worker: OrchestrationSessionWorker; origin: BotActivityOrigin }
  >()
  // Thread and run chats have no tab, so each is found by its status row's key or its link.
  const chatOrigins: [string, BotActivityOrigin | undefined][] = [
    ...input.sessions.map((session): [string, BotActivityOrigin | undefined] => [
      session.sessionId,
      originByPaneKey.get(session.paneKey)
    ]),
    ...input.runs.flatMap((run): [string, BotActivityOrigin | undefined][] =>
      run.chatSessionId
        ? [[run.chatSessionId, originByPaneKey.get(chatPaneKey(run.chatSessionId))]]
        : []
    ),
    ...input.links.flatMap((link): [string, BotActivityOrigin | undefined][] =>
      link.sessionId ? [[link.sessionId, { kind: 'thread', source: link.source }]] : []
    )
  ]
  const originBySessionId = new Map(
    chatOrigins.flatMap(([sessionId, origin]) => (origin ? [[sessionId, origin] as const] : []))
  )
  for (const { worker, creatorSessionId, creatorPaneKey } of input.recordedWorkers ?? []) {
    // A terminal run's or thread's worker names its creator by pane; a chat's, by session.
    const origin =
      (creatorSessionId ? originBySessionId.get(creatorSessionId) : undefined) ??
      (creatorPaneKey ? originByPaneKey.get(creatorPaneKey) : undefined)
    if (origin) {
      recorded.set(worker.dispatchId, { worker, origin })
    }
  }
  return recorded
}
