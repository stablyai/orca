// One story table driven through every lane that publishes a main agent's status. Each lane
// derives child liveness from its own evidence, but the published `{ state, workingMode, mainAgent }`
// must be what the shared fold says for that main agent and that evidence — a producer that folds
// differently is caught here structurally, not by review.
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { markClaudeLeadTurnInterrupted } from './agent-hook-listener/providers/claude-roster-state'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import { foldAgentLeadStatus } from './agent-lead-status-fold'
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import {
  agentChildWorkLiveness,
  agentChildWorkLivenessFromEvidence,
  type AgentChildWorkLiveness
} from './agent-status-child-work-liveness'
import type {
  AgentMainAgentStatus,
  AgentStatusState,
  AgentWorkingMode,
  ParsedAgentStatusPayload
} from './agent-status-types'
import { codexRosterEffectiveState, seedCodexSubagentRoster } from './codex-subagent-roster'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'
import type { AgentJournalTurnOutcome } from './agent-turn-outcome'

type Published = {
  state: AgentStatusState
  workingMode?: AgentWorkingMode
  mainAgent: Omit<AgentMainAgentStatus, 'stateStartedAt'>
}

const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }
/** Not a hook: current Claude sends none on a cancel, so Orca infers it from the keystroke. */
const ORCA_INFERRED_INTERRUPT = { orca_inferred_interrupt: true }
const RUNNING_AGENT = { id: 'agent-1', type: 'subagent', status: 'running' }
const AGENT_TASK: AgentSessionBackgroundTask = { id: 'agent-1', kind: 'agent', state: 'working' }
const SHELL_TASK: AgentSessionBackgroundTask = { id: 'shell-1', kind: 'command', state: 'working' }

function published(payload: ParsedAgentStatusPayload | null | undefined): Published {
  if (!payload?.mainAgent) {
    throw new Error('the lane published no main agent fact')
  }
  const { stateStartedAt: _clock, ...mainAgent } = payload.mainAgent
  return {
    state: payload.state,
    ...(payload.workingMode ? { workingMode: payload.workingMode } : {}),
    mainAgent
  }
}

/** The main agent's own state and verdict, restated as the fold's inputs. */
function refold(
  mainAgent: Published['mainAgent'],
  childWorkLiveness: AgentChildWorkLiveness
): Published {
  const resolution = foldAgentLeadStatus({
    leadState: mainAgent.state,
    interrupted: mainAgent.outcome === 'cancellation',
    childWorkLiveness
  })
  return {
    state: resolution.stateName,
    ...(resolution.workingMode ? { workingMode: resolution.workingMode } : {}),
    mainAgent
  }
}

type Story = {
  name: string
  claude?: { events: Record<string, unknown>[]; expect: Published }
  structured?: {
    status: 'working' | 'attention' | 'idle'
    backgroundTasks?: AgentSessionBackgroundTask[]
    turnOutcome?: AgentJournalTurnOutcome
    expect: Published
  }
  grok?: { events: Record<string, unknown>[]; expect: Published }
  codex?: { events: Record<string, unknown>[]; expect: Published }
}

const STORIES: Story[] = [
  {
    name: 'main agent working',
    claude: {
      events: [{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }],
      expect: { state: 'working', mainAgent: { state: 'working' } }
    },
    structured: {
      status: 'working',
      expect: { state: 'working', mainAgent: { state: 'working' } }
    },
    grok: {
      events: [{ hookEventName: 'user_prompt_submit', prompt: 'go' }],
      expect: { state: 'working', mainAgent: { state: 'working' } }
    },
    codex: {
      events: [{ hook_event_name: 'UserPromptSubmit', prompt: 'go' }],
      expect: { state: 'working', mainAgent: { state: 'working' } }
    }
  },
  {
    name: 'done with a live subagent',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_AGENT] }
      ],
      expect: { state: 'working', mainAgent: { state: 'done' } }
    },
    structured: {
      status: 'idle',
      backgroundTasks: [AGENT_TASK],
      expect: { state: 'working', mainAgent: { state: 'done' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop', reason: 'end_turn', backgroundTasks: [RUNNING_AGENT] }
      ],
      // Grok reports no task kind the roster can classify as agent work, so its live subagent
      // reads as watch work. Today's label, kept on purpose; a Grok-specific follow-up.
      expect: { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done' } }
    },
    codex: {
      // A root Stop with no transcript-tracked children clears the roster (Codex 0.144 could omit
      // child Stop hooks), so the child proves it is still alive with its next tool event.
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop' },
        { hook_event_name: 'PreToolUse', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'working', mainAgent: { state: 'done' } }
    }
  },
  {
    name: 'done with only a watch loop',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done' } }
    },
    structured: {
      status: 'idle',
      backgroundTasks: [SHELL_TASK],
      expect: { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop', reason: 'end_turn', backgroundTasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'working', workingMode: 'monitoring', mainAgent: { state: 'done' } }
    }
  },
  {
    name: 'blocked with a live subagent',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm' } }
      ],
      // The hook lane's vocabulary for "the main agent needs a human" is `waiting`.
      expect: { state: 'waiting', mainAgent: { state: 'waiting' } }
    },
    structured: {
      status: 'attention',
      backgroundTasks: [AGENT_TASK],
      expect: { state: 'blocked', mainAgent: { state: 'blocked' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'pre_tool_use', toolName: 'ask_user_question' }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'waiting' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'waiting' } }
    }
  },
  {
    name: 'failed turn',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'StopFailure', error: 'invalid_request' }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'failure' } }
    },
    structured: {
      status: 'idle',
      turnOutcome: 'failure',
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'failure' } }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop_failure' }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'failure' } }
    }
  },
  {
    // KNOWN DIVERGENCE, pinned on purpose. The hook lane hides a still-running shell after an
    // interrupted turn; the structured lane never feeds the verdict into the fold and keeps
    // showing the shell. The cancel policy (PR C) flips the hook-lane rows to monitoring and
    // must update this story, not delete it. The Claude row here is the primary path: Orca's
    // inferred cancel, carried by the main agent record into the next Stop, which lists the shell.
    name: 'interrupted with a watch loop (known divergence: CLI done / structured monitoring)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }
    },
    structured: {
      status: 'idle',
      turnOutcome: 'cancellation',
      backgroundTasks: [SHELL_TASK],
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      }
    },
    grok: {
      events: [
        { hookEventName: 'user_prompt_submit', prompt: 'go' },
        { hookEventName: 'stop_cancelled', backgroundTasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }
    }
  },
  {
    // Secondary source: a build that does send `is_interrupt` on its Stop. Same known divergence.
    name: 'interrupted by a Stop that carries is_interrupt, with a watch loop (older builds)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'Stop', is_interrupt: true, background_tasks: [RUNNING_SHELL] }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }
    }
  }
]

/** Codex never reports a blocked root; the combine's input type says so. */
function codexMainAgentState(state: AgentStatusState): 'working' | 'waiting' | 'done' {
  if (state === 'blocked') {
    throw new Error('Codex published a blocked main agent')
  }
  return state
}

/** The stories a lane takes part in, as `it.each` rows. */
function storiesFor<K extends 'claude' | 'structured' | 'grok' | 'codex'>(
  lane: K
): [string, NonNullable<Story[K]>][] {
  const rows: [string, NonNullable<Story[K]>][] = []
  for (const story of STORIES) {
    const entry = story[lane]
    if (entry !== undefined) {
      rows.push([story.name, entry])
    }
  }
  return rows
}

describe('mainAgent status parity across lanes', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  function drive(
    source: 'claude' | 'grok' | 'codex',
    events: Record<string, unknown>[]
  ): ParsedAgentStatusPayload {
    let last: ParsedAgentStatusPayload | null = null
    for (const payload of events) {
      if (payload === ORCA_INFERRED_INTERRUPT) {
        markClaudeLeadTurnInterrupted(state, PANE_KEY)
        continue
      }
      const event = normalizeHookPayload(
        state,
        source,
        { paneKey: PANE_KEY, payload },
        'production'
      )
      last = event?.payload ?? last
    }
    if (!last) {
      throw new Error('the lane published nothing')
    }
    return last
  }

  /** The hook lane's child evidence: the roster on the row, the shell and cron sets in memory. */
  function claudeChildWorkLiveness(payload: ParsedAgentStatusPayload): AgentChildWorkLiveness {
    return agentChildWorkLivenessFromEvidence({
      hasLiveAgentWork: payload.subagents?.some((child) => child.state === 'working') === true,
      hasLiveNonAgentWork:
        state.claudeRunningNonAgentTaskPaneKeys.has(PANE_KEY) ||
        state.claudeActiveSessionCronPaneKeys.has(PANE_KEY)
    })
  }

  describe('Claude hook lane', () => {
    it.each(storiesFor('claude'))('%s', (_name, lane) => {
      const payload = drive('claude', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      expect(row).toEqual(refold(row.mainAgent, claudeChildWorkLiveness(payload)))
    })
  })

  describe('structured lane', () => {
    it.each(storiesFor('structured'))('%s', (_name, lane) => {
      const row = structuredAgentSessionAgentStatus({
        status: lane.status,
        backgroundTasks: lane.backgroundTasks,
        turnOutcome: lane.turnOutcome
      })
      expect(row).toEqual(lane.expect)
      // This lane never feeds the verdict into the fold: refold with the verdict masked.
      const masked = { state: row.mainAgent.state }
      expect(refold(masked, agentChildWorkLiveness(lane.backgroundTasks))).toEqual({
        ...row,
        mainAgent: masked
      })
    })
  })

  describe('Grok hook lane', () => {
    it.each(storiesFor('grok'))('%s', (_name, lane) => {
      const payload = drive('grok', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      // Grok's child evidence lives only on its final plain `stop`: a finite task or an active
      // stop hook is watch work, and nothing else ever holds the pane.
      const last = lane.events.at(-1) ?? {}
      const tasks = Array.isArray(last.backgroundTasks) ? last.backgroundTasks : []
      const liveness: AgentChildWorkLiveness =
        last.hookEventName === 'stop' && (tasks.length > 0 || last.stopHookActive === true)
          ? 'monitoring'
          : null
      expect(row).toEqual(refold(row.mainAgent, liveness))
    })
  })

  describe('Codex hook lane (own combine, not the shared fold)', () => {
    it.each(storiesFor('codex'))('%s', (_name, lane) => {
      const payload = drive('codex', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
      // Codex keeps `codexRosterEffectiveState` until its combine moves onto the fold: a
      // waiting child wins, a settled root with any live child reads working, no monitoring.
      const roster = new Map()
      seedCodexSubagentRoster(roster, payload.subagents ?? [])
      expect(row.state).toBe(
        codexRosterEffectiveState(roster, codexMainAgentState(row.mainAgent.state))
      )
    })
  })
})
