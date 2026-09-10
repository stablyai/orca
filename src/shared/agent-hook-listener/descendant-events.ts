import type { AgentHookSource } from '../agent-hook-relay'
import { isAskUserQuestionTool } from '../agent-question-answered-intent'
import { readFirstString } from './interactive-tool'
import { isGrokEvent, normalizeHookEventName } from './provider-event-names'
import { readString } from './tool-input-preview'

/** One live descendant as its provider names it. */
export type DescendantEntry = {
  id: string
  agentType?: string
  description?: string
  model?: string
}

/** What one hook event says about the DESCENDANTS of the pane's lead session.
 *
 *  A descendant's lifecycle is not the pane's: it may change the child list, and it
 *  may never settle the pane or fire completion.
 *
 *  `child` is a delta from a provider whose child events each arrive as their own HTTP
 *  post, so none can be lost in transit. Its `id` is optional because some providers
 *  only mark an event as "this fired inside a child" without naming which one — still
 *  enough to refuse the settle.
 *
 *  `live-set` is the authoritative full set, for a provider whose transport can drop an
 *  intermediate message. Applying a delta over a lossy transport is unrecoverable — a
 *  lost removal strands a finished child and pins the pane 'working' with nothing left
 *  to clear it — whereas replacing the set makes every message self-sufficient, so the
 *  newest one repairs whatever was dropped before it. */
export type DescendantEventFacts =
  | ({
      kind: 'child'
      ended: boolean
      /** The child is blocked on a human answer. A descendant's wait is the pane's actionable
       *  state, so it surfaces even when the provider never names which child is waiting. */
      waiting?: boolean
    } & Partial<DescendantEntry>)
  | { kind: 'live-set'; children: readonly DescendantEntry[] }

/** How one provider reports its descendants. Both questions live together on purpose: a
 *  provider that opts into descendants MUST also answer how the pane recovers when a
 *  child's finish never arrives, or it silently inherits "no recovery". */
type DescendantProviderAdapter = {
  readEvent: (
    eventName: unknown,
    hookPayload: Record<string, unknown>
  ) => DescendantEventFacts | null
  /** An event proving the descendants tracked so far can no longer be alive — the pane's
   *  agent process was replaced, or the turn that owns them was torn down. */
  isScopeReset: (eventName: unknown, hookPayload: Record<string, unknown>) => boolean
}

function readGrokDescendantEvent(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  const isLifecycleEvent = isGrokEvent(eventName, 'subagent_start', 'subagent_stop', 'subagent_end')
  const subagentType = readFirstString(hookPayload, ['subagentType', 'subagent_type'])
  // Why: grok stamps `subagentType` on the payload of every event that can fire inside a child and
  // omits it in the main session, so its presence — not the event name — is what tells a child
  // apart. A child's own turn gate is remapped to SubagentStop, so the events that reach the
  // parent's pane are the child's SessionEnd/StopFailure, which inherit its ORCA_PANE_KEY.
  if (!isLifecycleEvent && subagentType === undefined) {
    return null
  }
  // Why: grok auto-allows ask_user_question, so a child blocked on a human answer announces it as
  // a PreToolUse. Routing child events away from the lead normalizer would otherwise drop that
  // wait entirely, and a pane silently waiting on an answer is the worst state to hide.
  const isChildAsking =
    isGrokEvent(eventName, 'pre_tool_use') &&
    isAskUserQuestionTool(readFirstString(hookPayload, ['toolName', 'tool_name', 'name']))
  return {
    kind: 'child',
    id: readFirstString(hookPayload, ['subagentId', 'subagent_id']),
    agentType: subagentType,
    description: readFirstString(hookPayload, ['description']),
    ...(isChildAsking ? { waiting: true } : {}),
    ended:
      isGrokEvent(eventName, 'subagent_stop', 'subagent_end') ||
      isGrokEvent(eventName, 'stop', 'session_end', 'stop_failure', 'stop_cancelled')
  }
}

function readPiDescendantEvent(
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  if (normalizeHookEventName(eventName) !== 'subagent_async_state') {
    return null
  }
  const runs = hookPayload['subagent_runs']
  if (!Array.isArray(runs)) {
    return null
  }
  const children: DescendantEntry[] = []
  for (const run of runs) {
    if (typeof run !== 'object' || run === null) {
      continue
    }
    const record = run as Record<string, unknown>
    const id = readFirstString(record, ['id', 'run_id', 'runId', 'subagent_id'])
    if (id) {
      children.push({
        id,
        agentType: readFirstString(record, ['agent_type', 'agentType']),
        description: readString(record, 'description'),
        model: readString(record, 'model')
      })
    }
  }
  return { kind: 'live-set', children }
}

/** Grok's own turn cancel. An interrupted turn skips the stop gate entirely, so a child
 *  spawned by that turn never reports a finish and the cancel is the only proof it is gone.
 *  A cancel carrying `subagentType` is one CHILD giving up (its own turn limit, or a declined
 *  permission) and must not tear down its siblings — `readEvent` ends just that child. */
function isGrokLeadTurnCancel(eventName: unknown, hookPayload: Record<string, unknown>): boolean {
  return (
    isGrokEvent(eventName, 'stop_cancelled') &&
    readFirstString(hookPayload, ['subagentType', 'subagent_type']) === undefined
  )
}

/** Every provider answers, or is explicitly `null` for "reports no child sessions on the
 *  parent's pane". A `Record` over the source union makes a new provider a compile error
 *  here, so descendant support and its recovery are decided together, in one place.
 *
 *  Claude and Codex are `null` because they own richer rosters of their own — Claude's
 *  carries teammate parking, `background_tasks` folding and restored-snapshot provenance;
 *  Codex's carries rollout reconciliation — and both already derive the pane from them. */
const DESCENDANT_PROVIDERS: Record<AgentHookSource, DescendantProviderAdapter | null> = {
  claude: null,
  codex: null,
  grok: {
    readEvent: readGrokDescendantEvent,
    isScopeReset: (eventName, hookPayload) =>
      isGrokEvent(eventName, 'session_start') || isGrokLeadTurnCancel(eventName, hookPayload)
  },
  pi: {
    readEvent: readPiDescendantEvent,
    isScopeReset: (eventName) => eventName === 'session_start'
  },
  // Why: omp and prime-agent share pi's normalizer but not its subagent extension, so they
  // report no children today; give one a reader here if that changes.
  omp: null,
  'prime-agent': null,
  gemini: null,
  antigravity: null,
  amp: null,
  opencode: null,
  'mimo-code': null,
  cursor: null,
  droid: null,
  'command-code': null,
  copilot: null,
  hermes: null,
  devin: null,
  kimi: null
}

/** Providers whose normalizer already tracks its own descendants and derives the pane state
 *  from them, so the generic path must not run a second, blinder copy over the same events. */
export function providerOwnsDescendantLifecycle(source: AgentHookSource): boolean {
  return source === 'claude' || source === 'codex'
}

export function readDescendantEventFacts(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): DescendantEventFacts | null {
  return DESCENDANT_PROVIDERS[source]?.readEvent(eventName, hookPayload) ?? null
}

export function isDescendantScopeResetEvent(
  source: AgentHookSource,
  eventName: unknown,
  hookPayload: Record<string, unknown>
): boolean {
  return DESCENDANT_PROVIDERS[source]?.isScopeReset(eventName, hookPayload) === true
}
