import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { AgentMainAgentStatus } from './agent-status-types'
import { foldMainAgentWithRowChildWork } from './agent-hook-row-child-work-fold'

const INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS = 15_000
const TOOL_PROGRESS_HOOK_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

export function isToolProgressWorkingAfterInterrupt(next: AgentHookEventPayload): boolean {
  if (next.payload.state !== 'working') {
    return false
  }
  if (next.payload.agentType !== 'claude' && next.payload.agentType !== 'codex') {
    return false
  }
  // Same-prompt retries submit anew; late Ctrl+C progress arrives as tool lifecycle events.
  return next.hookEventName !== undefined && TOOL_PROGRESS_HOOK_EVENTS.has(next.hookEventName)
}

type CancelledRow = AgentHookEventPayload & { receivedAt: number }

export type CancelVerdictLatchDecision =
  | { hold: true }
  | { hold: false; event: AgentHookEventPayload }

const HOLD: CancelVerdictLatchDecision = { hold: true }

/** Derive cancellation from mainAgent, or interrupted done rows on older hosts; never store another latch. */
function isCancelVerdictLatched(previous: CancelledRow): boolean {
  const mainAgent = previous.payload.mainAgent
  return mainAgent
    ? mainAgent.outcome === 'cancellation'
    : previous.payload.state === 'done' && previous.payload.interrupted === true
}

/** An event that restates child work can be re-folded with it; one that carries none has nothing to add. */
function carriesChildWork(event: AgentHookEventPayload): boolean {
  return event.payload.subagents !== undefined || event.claudeRunningNonAgentTask !== undefined
}

function refoldUnderLatchedMainAgent(
  previous: CancelledRow,
  latched: AgentMainAgentStatus,
  incoming: AgentHookEventPayload
): AgentHookEventPayload {
  // Why: a child's own attention state is child work, not the main agent's; only `working` is the stale restatement.
  const resolved = foldMainAgentWithRowChildWork(
    incoming.payload.state === 'working' ? latched.state : incoming.payload.state,
    {
      claudeRunningNonAgentTask:
        incoming.claudeRunningNonAgentTask ?? previous.claudeRunningNonAgentTask,
      payload: incoming.payload
    }
  )
  const {
    workingMode: _workingMode,
    interrupted: _interrupted,
    turnCompletedAt: _turnCompletedAt,
    ...rest
  } = incoming.payload
  return {
    ...incoming,
    payload: {
      ...rest,
      state: resolved.stateName,
      ...(resolved.workingMode ? { workingMode: resolved.workingMode } : {}),
      ...(resolved.stateName === 'done' ? { interrupted: true } : {}),
      mainAgent: latched
    }
  }
}

/** Main-agent submissions open turns even when harness notifications reuse the cached prompt. */
export function opensNewTurn(event: AgentHookEventPayload): boolean {
  return (
    event.hookEventName === 'SessionStart' ||
    (event.hookEventName === 'UserPromptSubmit' &&
      event.toolAgentId === undefined &&
      event.isReplay !== true)
  )
}

/** A child's own event: one naming its agent id, or a teammate's idle, which names it by `teammate_name` only. */
function isChildAttributed(event: AgentHookEventPayload): boolean {
  return event.toolAgentId !== undefined || event.hookEventName === 'TeammateIdle'
}

/** A child restates its listener's cached prompt, which a restarted relay has lost; empty there is unknown, not another turn. */
export function restatesAnotherPrompt(
  previous: Pick<AgentHookEventPayload, 'payload'>,
  incoming: AgentHookEventPayload
): boolean {
  const prompt = incoming.payload.prompt
  return prompt !== previous.payload.prompt && (prompt !== '' || !isChildAttributed(incoming))
}

/** Hold inferred cancellation against late same-turn hooks/replays until a provider verdict or new turn. Child events retain the main verdict and refold child evidence; relays do not know desktop-inferred cancellation. */
export function resolveCancelVerdictLatch(
  previous: CancelledRow | undefined,
  incoming: AgentHookEventPayload,
  now: number
): CancelVerdictLatchDecision {
  const apply: CancelVerdictLatchDecision = { hold: false, event: incoming }
  if (
    !previous ||
    !isCancelVerdictLatched(previous) ||
    previous.payload.agentType !== incoming.payload.agentType ||
    restatesAnotherPrompt(previous, incoming) ||
    incoming.payload.mainAgent?.state === 'done' ||
    opensNewTurn(incoming)
  ) {
    return apply
  }
  const latched = previous.payload.mainAgent
  // Why: Codex's combine is not this fold; its child events already come reconciled against main's marked record.
  if (
    latched &&
    incoming.payload.agentType !== 'codex' &&
    incoming.payload.state !== 'done' &&
    (isChildAttributed(incoming) || incoming.isReplay === true) &&
    carriesChildWork(incoming)
  ) {
    return { hold: false, event: refoldUnderLatchedMainAgent(previous, latched, incoming) }
  }
  const withinWindow = now - previous.receivedAt <= INTERRUPTED_DONE_LATE_WORKING_SUPPRESSION_MS
  if (incoming.payload.state === 'done') {
    return previous.payload.state === 'done' && withinWindow ? HOLD : apply
  }
  if (
    incoming.payload.state === 'working' &&
    (incoming.isReplay === true ||
      isToolProgressWorkingAfterInterrupt(incoming) ||
      (incoming.hasExplicitPrompt !== true && withinWindow))
  ) {
    return HOLD
  }
  return apply
}
