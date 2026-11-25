// A bot's one feed, built by its host at read time from its sessions, its automations and the workers they started.
import type { AgentDotState } from '../agent-dot-state'
import { agentRowDotState } from '../agent-row-dot-state'
import { getToneForAutomationRunStatus } from '../automation-last-run'
import { getAutomationRunLastRunAt } from '../automations/history/automation-run'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext
} from '../agent-status/contracts/agent-status-types'
import type { Automation } from '../automations/automation-definition'
import type { AutomationRun, AutomationRunStatus } from '../automations/history/automation-run'
import type { Bot } from '../bot-types'
import type { OrchestrationSessionWorker } from '../orchestration-session-workers'
import type { ExternalConversationLink } from '../connectors/external-conversation-link'
import { externalConversationTitle } from '../external-conversation-title'
import { structuredAgentSessionStatusPaneKey } from '../agent-session/view/structured-agent-session-tab'
import { botAutomationRows, type BotAutomationRow } from './bot-automation-rows'
import {
  botWorkerTool,
  clipActivityTitle,
  recordedWorkerRow,
  recordedWorkersByDispatch,
  workerRowIsRunning
} from './bot-activity-recorded-workers'
import { handedAgentRows, type BotHandedAgentObservation } from './bot-activity-handed-agents'
import type { BotUpNext } from './bot-look-around'
import { pendingWaits, waitDueAt } from '../automation-once'

/** Completed work kept on screen; older rows live in the Automations page and Session History. */
export const BOT_ACTIVITY_COMPLETED_LIMIT = 20

/** What started a row: your chat, an outside thread, an automation or another of the bot's sessions. */
export type BotActivityOrigin =
  | { kind: 'chat' }
  | { kind: 'thread'; source: ExternalConversationLink['source'] }
  | { kind: 'automation'; name: string }
  | { kind: 'session'; label: string }

export type BotWorkerRow = {
  kind: 'worker'
  key: string
  dispatchId: string
  title: string
  dot: AgentDotState
  origin: BotActivityOrigin
  /** The worker's own pane, which a click reveals; null for a chat worker. */
  paneKey: string | null
  workspaceId: string | null
  /** The paired computer the workspace runs on; absent on this computer. */
  hostId?: `runtime:${string}`
  at: number
  /** The host's own record of this worker, when a bot chat started it. */
  worker: OrchestrationSessionWorker | null
  /** The tool a permission prompt asks about, as its status reports it; absent from older hosts. */
  tool?: BotWorkerTool
}

export type BotWorkerTool = { name: string; input: string | null }

/** Only what the row shows and opens; prompts, output and logs stay behind the run's own detail reads. */
export type BotRunRow = {
  kind: 'run'
  key: string
  automationId: string
  automationName: string
  runId: string
  status: AutomationRunStatus
  /** The run's own chat, which a click opens; null for a run in a terminal. */
  sessionId: string | null
  /** A finished run's own status; a running run's live chat status (an approval it waits on, say), else null. */
  dot: AgentDotState | null
  at: number
}

/** An outside thread's own chat; it has no tab until someone opens it from here. */
export type BotThreadRow = {
  kind: 'thread'
  key: string
  title: string
  source: ExternalConversationLink['source']
  dot: AgentDotState
  sessionId: string
  at: number
}

export type BotSessionActivityRow = BotWorkerRow | BotRunRow | BotThreadRow

export type BotActivity = {
  /** Workers still running, newest first. */
  workers: BotWorkerRow[]
  inProgress: BotSessionActivityRow[]
  completed: BotSessionActivityRow[]
  /** Every automation that runs in the bot's home, as its Automations list shows them. */
  automations: BotAutomationRow[]
  /** Its waits still waiting, by deadline. */
  waits: BotAutomationRow[]
  /** What the bot's looks found; absent while Look around is off. */
  upNext?: BotUpNext
}

/** A worker the host recorded, with the chat or pane whose Dispatch started it. */
export type BotRecordedWorker = {
  worker: OrchestrationSessionWorker
  creatorSessionId: string | null
  creatorPaneKey: string | null
}

/** One of the bot's sessions, open as a tab in its home. */
export type BotSessionTab = { paneKey: string; sessionId: string; label: string }

/** The parts of an agent's status row Activity reads. */
export type BotActivityStatus = Pick<
  AgentStatusEntry,
  'state' | 'workingMode' | 'prompt' | 'stateStartedAt' | 'toolName' | 'toolInput'
>

/** An orchestration worker as the agent-status store sees it. */
export type BotWorkerObservation = {
  paneKey: string
  orchestration: AgentStatusOrchestrationContext
  entry: BotActivityStatus | null
  worktreeId: string | null
}

export type BotActivityInput = {
  bot: Bot
  sessions: readonly BotSessionTab[]
  links: readonly ExternalConversationLink[]
  workers: readonly BotWorkerObservation[]
  /** Agents in the workspaces under the bot's home; only live ones are shown. */
  handedAgents?: readonly BotHandedAgentObservation[]
  /** Workers the bot's chats and panes started, as its host records them. */
  recordedWorkers?: readonly BotRecordedWorker[]
  /** Automations that run in the bot's home. */
  automations: readonly Automation[]
  runs: readonly AutomationRun[]
  /** A chat's status row, live or retained, read whether or not it has a tab. */
  sessionStatus: (sessionId: string) => BotActivityStatus | null
}

function sessionOrigin(
  input: BotActivityInput,
  session: BotSessionTab,
  automationBySessionId: ReadonlyMap<string, Automation>
): BotActivityOrigin {
  if (session.sessionId === input.bot.chatSessionId) {
    return { kind: 'chat' }
  }
  const automation = automationBySessionId.get(session.sessionId)
  return automation
    ? { kind: 'automation', name: automation.name }
    : { kind: 'session', label: session.label }
}

function workerRow(
  worker: BotWorkerObservation,
  origin: BotActivityOrigin,
  recorded: OrchestrationSessionWorker | null
): BotWorkerRow {
  const { orchestration, entry } = worker
  if (recorded) {
    const row = recordedWorkerRow(recorded, origin, worker.paneKey)
    // The record has no tool; the pane's own status does.
    return { ...row, ...botWorkerTool(entry, row.dot) }
  }
  const dot: AgentDotState =
    orchestration.dispatchStatus === 'completed'
      ? 'done'
      : orchestration.dispatchStatus === 'failed' ||
          orchestration.dispatchStatus === 'circuit_broken'
        ? 'failed'
        : entry
          ? agentRowDotState(entry.state, entry.workingMode)
          : 'working'
  return {
    kind: 'worker',
    key: `worker:${orchestration.dispatchId}`,
    dispatchId: orchestration.dispatchId,
    title: clipActivityTitle(
      orchestration.taskTitle || orchestration.displayName || entry?.prompt || ''
    ),
    dot,
    origin,
    paneKey: worker.paneKey,
    workspaceId: worker.worktreeId,
    at: entry?.stateStartedAt ?? 0,
    worker: null,
    ...botWorkerTool(entry, dot)
  }
}

const byNewest = (a: { at: number }, b: { at: number }): number => b.at - a.at

function sessionDot(entry: BotActivityStatus | null): AgentDotState | null {
  return entry ? agentRowDotState(entry.state, entry.workingMode) : null
}

/** The dot a run's own status draws, for a run row without a chat status to show. */
export function automationRunDot(status: AutomationRunStatus): AgentDotState {
  switch (getToneForAutomationRunStatus(status)) {
    case 'running':
      return 'working'
    case 'succeeded':
      return 'done'
    case 'failed':
      return 'failed'
    case 'skipped':
    case 'never':
    case 'unknown':
      return 'idle'
  }
}

/** Still going, or waiting on someone: everything else is finished. */
function isLive(dot: AgentDotState): boolean {
  return dot === 'working' || dot === 'monitoring' || dot === 'blocked' || dot === 'waiting'
}

export function buildBotActivity(input: BotActivityInput): BotActivity {
  const automationById = new Map(input.automations.map((automation) => [automation.id, automation]))
  // Where work starts: the bot's sessions, its threads, and each automation run's own agent.
  const originByPaneKey = new Map<string, BotActivityOrigin>()
  const automationBySessionId = new Map<string, Automation>()
  for (const run of input.runs) {
    const automation = automationById.get(run.automationId)
    if (!automation) {
      continue
    }
    if (run.chatSessionId) {
      automationBySessionId.set(run.chatSessionId, automation)
      // A run's chat has no tab, so its workers find it by its status row's key.
      originByPaneKey.set(structuredAgentSessionStatusPaneKey(run.chatSessionId), {
        kind: 'automation',
        name: automation.name
      })
    }
    if (run.terminalPaneKey) {
      originByPaneKey.set(run.terminalPaneKey, { kind: 'automation', name: automation.name })
    }
  }
  // An outside thread's link names its agent by pane key, whether a chat or a terminal.
  for (const link of input.links) {
    originByPaneKey.set(link.paneKey, { kind: 'thread', source: link.source })
  }
  for (const session of input.sessions) {
    // The Chat is also reached from direct messages, but it is still your chat.
    if (session.sessionId === input.bot.chatSessionId || !originByPaneKey.has(session.paneKey)) {
      originByPaneKey.set(session.paneKey, sessionOrigin(input, session, automationBySessionId))
    }
  }
  const parentByPaneKey = new Map(
    input.workers.map((worker) => [worker.paneKey, worker.orchestration.parentPaneKey])
  )
  /** A worker a worker started belongs to whatever started the first one. */
  const originOf = (worker: BotWorkerObservation): BotActivityOrigin | null => {
    const seen = new Set<string>()
    let paneKey = worker.orchestration.parentPaneKey
    while (paneKey && !seen.has(paneKey)) {
      const origin = originByPaneKey.get(paneKey)
      if (origin) {
        return origin
      }
      seen.add(paneKey)
      paneKey = parentByPaneKey.get(paneKey)
    }
    return null
  }

  const workers: BotWorkerRow[] = []
  const inProgress: BotSessionActivityRow[] = []
  const completed: BotSessionActivityRow[] = []
  const recordedByDispatch = recordedWorkersByDispatch(input, originByPaneKey)
  const placeWorker = (row: BotWorkerRow): void => {
    ;(workerRowIsRunning(row) ? workers : completed).push(row)
  }

  for (const worker of input.workers) {
    const origin = originOf(worker)
    if (!origin) {
      continue
    }
    const recorded = recordedByDispatch.get(worker.orchestration.dispatchId)
    recordedByDispatch.delete(worker.orchestration.dispatchId)
    placeWorker(workerRow(worker, origin, recorded?.worker ?? null))
  }
  // A chat worker has no terminal pane for the runtime's projection to see; its host record stands alone.
  for (const { worker, origin } of recordedByDispatch.values()) {
    placeWorker(recordedWorkerRow(worker, origin, null))
  }
  // An agent in the bot's workspaces that is one of its own workers already has its row, here or on a
  // paired computer: pane keys carry a leaf UUID, so one set serves every host.
  const placed = new Set(
    [...workers, ...completed].flatMap((row) =>
      row.kind === 'worker' && row.paneKey ? [row.paneKey] : []
    )
  )
  workers.push(
    ...handedAgentRows((input.handedAgents ?? []).filter((agent) => !placed.has(agent.paneKey)))
  )

  for (const run of input.runs) {
    const automation = automationById.get(run.automationId)
    if (!automation) {
      continue
    }
    const sessionId = run.chatSessionId ?? null
    // The run's own status owns whether it is in progress: its chat may be shared and busy with later work.
    const running = getToneForAutomationRunStatus(run.status) === 'running'
    const chatDot = running && sessionId ? sessionDot(input.sessionStatus(sessionId)) : null
    const dot = running
      ? chatDot && isLive(chatDot)
        ? chatDot
        : null
      : automationRunDot(run.status)
    const row: BotRunRow = {
      kind: 'run',
      key: `run:${run.id}`,
      automationId: automation.id,
      automationName: clipActivityTitle(automation.name),
      runId: run.id,
      status: run.status,
      sessionId,
      dot,
      at: getAutomationRunLastRunAt(run)
    }
    ;(running ? inProgress : completed).push(row)
  }

  for (const link of input.links) {
    // Direct messages reach the bot's Chat, which is its Home tab, not a thread of its own.
    if (!link.sessionId || link.sessionId === input.bot.chatSessionId) {
      continue
    }
    const entry = input.sessionStatus(link.sessionId)
    const row: BotThreadRow = {
      kind: 'thread',
      key: `thread:${link.sessionId}`,
      // The link's title outlives the chat's status row; an older Orca's link has none.
      title: clipActivityTitle(
        link.title ?? (entry?.prompt ? externalConversationTitle(link.source, entry.prompt) : '')
      ),
      source: link.source,
      dot: sessionDot(entry) ?? 'done',
      sessionId: link.sessionId,
      at: entry?.stateStartedAt ?? link.createdAt
    }
    ;(isLive(row.dot) ? inProgress : completed).push(row)
  }

  return {
    workers: workers.sort(byNewest),
    inProgress: inProgress.sort(byNewest),
    completed: completed.sort(byNewest).slice(0, BOT_ACTIVITY_COMPLETED_LIMIT),
    automations: botAutomationRows(
      input.automations.filter((automation) => !automation.once),
      input.runs
    ),
    waits: botAutomationRows(pendingWaits(input.automations, input.runs), []).sort(
      (a, b) => waitDueAt(a.automation) - waitDueAt(b.automation)
    )
  }
}
