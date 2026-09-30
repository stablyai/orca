import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from '../../agent-hook-listener'
import { CLAUDE_PROMPT_ID, PANE_KEY } from '../../agent-hook-listener-test-harness'
import type { HookReplayEvidence } from '../listener-event'
import {
  clearPaneCacheState,
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from '../listener-state'
import { foldClaudeApprovalEvent, type ClaudeApprovalRecord } from './claude-approval-ledger'
import { markClaudeLeadTurnInterrupted } from './claude-roster-state'
import { clearClaudeAnsweredQuestionWait } from './claude-wait-lifecycle'

// Which event ends which outstanding Claude prompt. Each row is one event against a pane holding
// four prompts — the main agent's permission and question, child X's permission, child Y's
// question — and names the prompts left and how many announced call ids survive. `main` is what
// the main branch did with each prompt raised alone (one prompt slot, held on the server while the
// pane resolved working), probed against it; `why` explains a deliberate difference. Hook bodies are hand-built to the captured shapes.

type Payload = Record<string, unknown>
type Label = string

const X = { agent_id: 'a1f00d', agent_type: 'general-purpose' }
const Y = { agent_id: 'a2beef', agent_type: 'general-purpose' }
const TEAMMATE = { agent_id: 'areviewer-0123abcd', agent_type: 'reviewer' }
// Why: over the roster's id cap, so the roster never tracks it.
const UNTRACKED = { agent_id: `a${'0'.repeat(70)}`, agent_type: 'general-purpose' }
const MAIN_CALL = { tool_name: 'Bash', tool_input: { command: 'chmod 644 alpha.txt' } }
const X_CALL = { tool_name: 'Edit', tool_input: { file_path: 'x.ts' } }
const QUESTION = {
  tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question: 'Which?' }] }
}
const SIBLING = { tool_name: 'Read', tool_input: { file_path: 'notes.md' } }

const pre = (call: Payload, id: string, owner: Payload = {}): Payload => ({
  hook_event_name: 'PreToolUse',
  ...owner,
  ...call,
  tool_use_id: id
})
const permission = (call: Payload, owner: Payload = {}): Payload => ({
  hook_event_name: 'PermissionRequest',
  ...owner,
  ...call
})
const stop = (tasks?: Payload[], extra: Payload = {}): Payload => ({
  hook_event_name: 'Stop',
  ...(tasks ? { background_tasks: tasks } : {}),
  ...extra
})
const task = (owner: Payload, status: string): Payload => ({
  id: owner.agent_id,
  type: 'subagent',
  status
})
const SHELL_RUNNING = { id: 'b1', type: 'local_bash', status: 'running' }

const SEED: Payload[] = [
  { hook_event_name: 'UserPromptSubmit', prompt: 'ship it', session_id: 's-1' },
  { hook_event_name: 'SubagentStart', ...X },
  { hook_event_name: 'SubagentStart', ...Y },
  pre(MAIN_CALL, 'toolu-m'),
  permission(MAIN_CALL),
  pre(X_CALL, 'toolu-x', X),
  permission(X_CALL, X),
  pre(QUESTION, 'toolu-qy', Y),
  pre(QUESTION, 'toolu-qm')
]
const ALL: Label[] = ['main:permission', 'X:permission', 'Y:question', 'main:question']
const CHILDREN: Label[] = ['X:permission', 'Y:question']

type Row = {
  event: string
  /** Replaces SEED for a row that needs a different starting ledger. */
  seed?: Payload[]
  /** Extra events after the seed, before the event under test. */
  before?: Payload[]
  send?: Payload
  replay?: HookReplayEvidence
  act?: (state: HookListenerState) => void
  left: Label[]
  announced: number
  main: string
  why?: string
}

// One row per line, so the table reads as one.
// oxfmt-ignore
const ROWS: Row[] = [
  // Tool events
  { event: 'PreToolUse, main agent, a new call', send: pre(SIBLING, 'toolu-s'), left: ['main:permission', 'X:permission', 'Y:question'], announced: 5, main: "same for the main agent's prompts; dropped Y's question", why: "a child's question is its own; the main agent's activity answers none of it" },
  { event: 'PreToolUse, main agent, the approved call again', send: pre(MAIN_CALL, 'toolu-m'), left: ['main:permission', 'X:permission', 'Y:question'], announced: 4, main: 'released the permission as the call resuming', why: 'Claude announces a call before prompting for it, so a PreToolUse answers nothing' },
  { event: 'PreToolUse, child X', send: pre(SIBLING, 'toolu-xs', X), left: ALL, announced: 5, main: 'held, but disarmed the hold, so the next sibling completion released it', why: 'a child call answers no prompt' },
  { event: 'PreToolUse, child Y (its question pending)', send: pre(SIBLING, 'toolu-ys', Y), left: ['main:permission', 'X:permission', 'main:question'], announced: 5, main: 'same for the question' },
  { event: 'PostToolUse, main agent, the approved call by id', send: { ...pre(MAIN_CALL, 'toolu-m'), hook_event_name: 'PostToolUse' }, left: ['X:permission', 'Y:question', 'main:question'], announced: 4, main: 'same (released the one slot)' },
  { event: 'PostToolUse, main agent, the approved call by tool and input', send: { hook_event_name: 'PostToolUse', ...MAIN_CALL }, left: ['X:permission', 'Y:question', 'main:question'], announced: 4, main: 'held the permission (no id to release on); dropped both questions', why: "the call's own completion answers its prompt, and no question" },
  { event: 'PostToolUse, main agent, a sibling call', send: { ...pre(SIBLING, 'toolu-s'), hook_event_name: 'PostToolUse' }, left: ALL, announced: 4, main: "same (the sibling's own id kept both questions)" },
  { event: 'PostToolUseFailure, main agent, the approved call (id only)', send: { hook_event_name: 'PostToolUseFailure', tool_use_id: 'toolu-m' }, left: ['X:permission', 'Y:question', 'main:question'], announced: 4, main: 'held until the turn ended', why: 'the fix: a failed approved call was still approved' },
  { event: 'PostToolUse, child X, its approved call', send: { ...pre(X_CALL, 'toolu-x', X), hook_event_name: 'PostToolUse' }, left: ['main:permission', 'Y:question', 'main:question'], announced: 4, main: 'same' },
  // Prompts
  { event: 'PermissionRequest, main agent, a second call', send: permission(SIBLING), left: [...ALL, 'main:permission'], announced: 4, main: 'replaced the one slot', why: 'the first dialog is still on screen' },
  { event: 'PermissionRequest, main agent, re-delivered', send: permission(MAIN_CALL), left: ALL, announced: 4, main: 'same' },
  { event: 'UserPromptSubmit, typed', send: { hook_event_name: 'UserPromptSubmit', prompt: 'next' }, left: [], announced: 0, main: 'same' },
  { event: 'UserPromptSubmit, injected task notification', send: { hook_event_name: 'UserPromptSubmit', prompt: '<task-notification>shell done</task-notification>' }, left: ['main:permission', 'X:permission', 'Y:question'], announced: 4, main: 'held the permission; every question dropped', why: "a child's question is its own; the main agent's activity answers none of it" },
  { event: 'UserPromptSubmit, compact continuation', send: { hook_event_name: 'UserPromptSubmit', prompt: 'This session is being continued from a previous conversation.' }, left: ALL, announced: 4, main: 'same (ignored)' },
  { event: 'UserPromptSubmit, typed by a child', send: { hook_event_name: 'UserPromptSubmit', ...TEAMMATE, prompt: 'review x.ts' }, left: ALL, announced: 4, main: 'same (re-stated waiting)' },
  // Main agent turn ends
  { event: 'Stop, child-attributed', send: stop([], TEAMMATE), left: ALL, announced: 4, main: 'same (re-stated waiting)' },
  { event: 'Stop, main agent, no inventory (older build)', send: stop(), left: CHILDREN, announced: 0, main: 'held both permissions while the pane resolved working; dropped both questions', why: "a Stop proves the main agent isn't blocked on its own prompt; a working child's question is still on screen" },
  { event: 'Stop, main agent, X and Y running', send: stop([task(X, 'running'), task(Y, 'running')]), left: CHILDREN, announced: 0, main: 'held both permissions while the pane resolved working; dropped both questions', why: 'as above' },
  { event: 'Stop, main agent, X completed and Y running', send: stop([task(X, 'completed'), task(Y, 'running')]), left: ['Y:question'], announced: 0, main: "held X's prompt until Y's work ended; dropped Y's question", why: 'a child the inventory retired asks nothing, whatever else runs' },
  { event: 'Stop, main agent, X and Y completed, a shell running', send: stop([task(X, 'completed'), task(Y, 'completed'), SHELL_RUNNING]), left: [], announced: 0, main: "held X's prompt for the shell's whole run", why: 'as above' },
  { event: 'Stop, main agent, empty inventory', send: stop([]), left: [], announced: 0, main: 'same (the done row replaced it)' },
  { event: 'Stop, main agent, an untracked child and a shell', before: [permission(X_CALL, UNTRACKED)], send: stop([task(X, 'completed'), task(Y, 'completed'), SHELL_RUNNING]), left: [`${UNTRACKED.agent_id}:permission`], announced: 0, main: 'same (held while the pane resolved working)' },
  { event: 'Stop, main agent, a prompting teammate still listed', before: [{ hook_event_name: 'SubagentStart', ...TEAMMATE }, permission(SIBLING, TEAMMATE)], send: stop([task(X, 'completed'), task(Y, 'completed'), { id: 't1', type: 'teammate', status: 'running' }]), left: [`${TEAMMATE.agent_id}:permission`], announced: 0, main: 'same (held while the pane resolved working)' },
  { event: 'StopFailure, main agent', send: { hook_event_name: 'StopFailure', error: 'rate_limit' }, left: CHILDREN, announced: 0, main: 'held both permissions while the pane resolved working; dropped both questions', why: 'as for Stop' },
  { event: 'PostCompact, manual', send: { hook_event_name: 'PostCompact', trigger: 'manual' }, left: CHILDREN, announced: 0, main: 'held all while the pane resolved working', why: 'as for Stop' },
  // Events that map to nothing
  ...['PreCompact', 'Notification', 'PostToolBatch', 'SessionEnd'].map((name): Row => ({ event: name, send: { hook_event_name: name }, left: ALL, announced: 4, main: 'same (not mapped)' })),
  { event: 'PostCompact, auto', send: { hook_event_name: 'PostCompact', trigger: 'auto' }, left: ALL, announced: 4, main: 'same (not mapped)' },
  // Session boundaries
  ...['startup', 'resume', 'clear'].map((source): Row => ({ event: `SessionStart, ${source}`, send: { hook_event_name: 'SessionStart', source }, left: [], announced: 0, main: 'same (the done row replaced it)' })),
  { event: 'SessionStart, compact', send: { hook_event_name: 'SessionStart', source: 'compact' }, left: ALL, announced: 4, main: 'same (ignored)' },
  { event: 'SessionStart, child-attributed', send: { hook_event_name: 'SessionStart', source: 'startup', ...X }, left: ALL, announced: 4, main: 'same (ignored)' },
  { event: 'PreToolUse from a replacing session_id', send: { ...pre(SIBLING, 'toolu-n'), session_id: 's-2' }, left: ['main:permission', 'X:permission', 'Y:question'], announced: 5, main: 'same as any main agent PreToolUse' },
  { event: 'Stop from a replacing session_id', before: [{ ...pre(SIBLING, 'toolu-n'), session_id: 's-2' }], send: stop(undefined, { session_id: 's-2' }), left: [], announced: 0, main: 'same (the voided children left the pane done)' },
  // Child lifecycle
  { event: 'SubagentStart, a new child', send: { hook_event_name: 'SubagentStart', agent_id: 'a3cafe' }, left: ALL, announced: 4, main: 'same' },
  { event: 'SubagentStop, child X', send: { hook_event_name: 'SubagentStop', ...X }, left: ['main:permission', 'Y:question', 'main:question'], announced: 4, main: 'same (the owner ended)' },
  { event: 'StopFailure, child X', send: { hook_event_name: 'StopFailure', ...X, error: 'rate_limit' }, left: ['main:permission', 'Y:question', 'main:question'], announced: 4, main: 'same (the owner ended)' },
  { event: 'TeammateIdle, the prompting teammate', before: [{ hook_event_name: 'SubagentStart', ...TEAMMATE }, permission(SIBLING, TEAMMATE)], send: { hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' }, left: ALL, announced: 4, main: 'same (the owner ended)' },
  { event: 'SubagentStop, the owner of the only prompt', seed: [...SEED.slice(0, 4), pre(X_CALL, 'toolu-x', X), permission(X_CALL, X)], send: { hook_event_name: 'SubagentStop', ...X }, left: [], announced: 2, main: 'same for the prompt', why: 'the turn is not over, so its announced ids stay' },
  // Inferred and non-hook paths
  { event: 'inferred interrupt', act: (state) => markClaudeLeadTurnInterrupted(state, PANE_KEY), left: [], announced: 0, main: 'same' },
  { event: 'inferred question answer', act: (state) => clearClaudeAnsweredQuestionWait(state, PANE_KEY), left: ['main:permission', 'X:permission', 'Y:question'], announced: 4, main: 'released the one slot', why: 'only the question on screen was answered' },
  { event: 'inferred answer of the only prompt', seed: [SEED[0], pre(MAIN_CALL, 'toolu-m'), pre(QUESTION, 'toolu-qm')], act: (state) => clearClaudeAnsweredQuestionWait(state, PANE_KEY), left: [], announced: 2, main: 'same for the prompt', why: 'the turn is not over, so its announced ids stay' },
  { event: 'pane teardown', act: (state) => clearPaneCacheState(state, PANE_KEY), left: [], announced: 0, main: 'same' },
  // Durable re-delivery from the spool
  { event: 'replayed PermissionRequest from a relay (no times)', send: permission(SIBLING), replay: {}, left: ALL, announced: 4, main: 'raised it', why: 'the completion that settled it is never replayed' },
  { event: 'replayed PermissionRequest spooled while Orca was down', send: permission(SIBLING), replay: { observedAt: 2, lastLiveAt: 1 }, left: [...ALL, 'main:permission'], announced: 4, main: 'same' },
  { event: 'replayed Stop', send: stop([]), replay: {}, left: [], announced: 0, main: 'same' }
]
// Decided on the server, pinned elsewhere: an OSC `working` repaint never releases a hook-raised
// permission and still clears an answered question (server-claude-held-approval-repaint.test.ts);
// a hydrated row seeds no prompts (seedClaudeLeadTurnFromPersistedStatus).

function label(record: ClaudeApprovalRecord): Label {
  const owner =
    record.agentId === undefined
      ? 'main'
      : record.agentId === X.agent_id
        ? 'X'
        : record.agentId === Y.agent_id
          ? 'Y'
          : record.agentId
  return `${owner}:${record.settledBy === 'any-tool-event' ? 'question' : 'permission'}`
}

describe('Claude approval boundaries', () => {
  let state: HookListenerState
  // Why: accepted as the server would, so a manual compact finds the row it may clear.
  const send = (payload: Payload, replay?: HookReplayEvidence): void => {
    const event = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: { prompt_id: CLAUDE_PROMPT_ID, ...payload } },
      'production',
      replay ? { replay } : {}
    )
    if (event) {
      seedLegacyAgentStatusForTests(state, event)
    }
  }

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('seeds four outstanding prompts and their announced ids', () => {
    SEED.forEach((payload) => send(payload))
    const lead = state.claudeLeadStateByPaneKey.get(PANE_KEY)
    expect(lead?.approvals?.map(label)).toEqual(ALL)
    expect(Object.keys(lead?.announcedCalls ?? {})).toHaveLength(4)
  })

  it.each(ROWS.map((row) => [row.event, row] as const))('%s', (_event, row) => {
    ;(row.seed ?? SEED).forEach((payload) => send(payload))
    row.before?.forEach((payload) => send(payload))
    if (row.send) {
      send(row.send, row.replay)
    }
    row.act?.(state)
    const lead = state.claudeLeadStateByPaneKey.get(PANE_KEY)
    expect({
      left: (lead?.approvals ?? []).map(label),
      announced: Object.keys(lead?.announcedCalls ?? {}).length
    }).toEqual({ left: row.left, announced: row.announced })
  })

  // The listener discards a child event's fold today, so only the ledger itself shows who may end a turn.
  it.each([
    ['a typed UserPromptSubmit', { eventName: 'UserPromptSubmit', opensUserTurn: true }],
    ['a Stop', { eventName: 'Stop', opensUserTurn: false }]
  ])('never lets %s from a child end the main agent turn', (_event, boundary) => {
    const approvals: ClaudeApprovalRecord[] = [
      { toolName: 'Bash', settledBy: 'completion', card: {} },
      { agentId: X.agent_id, toolName: 'Edit', settledBy: 'completion', card: {} }
    ]
    const fold = foldClaudeApprovalEvent({
      carriedOver: { approvals },
      ...boundary,
      agentId: TEAMMATE.agent_id,
      toolName: undefined,
      toolInput: undefined,
      raisesWait: false,
      raisesQuestionWait: false,
      mainAgentTurnEnd: { childOutlivesTurn: () => false }
    })
    expect(fold.approvals).toBe(approvals)
  })
})
