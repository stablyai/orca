// Drive independent main-agent story expectations through each publishing lane.
import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import { markClaudeLeadTurnInterrupted } from './agent-hook-listener/providers/claude-roster-state'
import { markCodexLeadTurnInterrupted } from './agent-hook-listener/providers/codex-state'
import {
  createHookListenerState,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import type {
  AgentMainAgentStatus,
  AgentStatusState,
  AgentWorkingMode,
  ParsedAgentStatusPayload
} from './agent-status-types'
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
      expect: { state: 'working', mainAgent: { state: 'done' } }
    },
    codex: {
      // Codex 0.144 could omit child Stop hooks; root Stop clears untracked children until their next tool event proves liveness.
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
    // Claude records a child's wait by displacing the main agent record; Codex keeps it on the
    // child. Both publish the main agent's own state beside the waiting row.
    name: 'a child waiting on the user',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        {
          hook_event_name: 'PermissionRequest',
          agent_id: 'agent-1',
          tool_name: 'Bash',
          tool_input: { command: 'rm' }
        }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'working' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'PermissionRequest', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'working' } }
    }
  },
  {
    name: 'settled main agent whose child is waiting on the user',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_AGENT] },
        {
          hook_event_name: 'PermissionRequest',
          agent_id: 'agent-1',
          tool_name: 'Bash',
          tool_input: { command: 'rm' }
        }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'done' } }
    },
    // KNOWN DIVERGENCE: structured attention folds a child’s prompt into the main agent’s blocked state as well as its waiting child record.
    structured: {
      status: 'attention',
      backgroundTasks: [{ ...AGENT_TASK, state: 'waiting' }],
      expect: { state: 'blocked', mainAgent: { state: 'blocked' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop' },
        { hook_event_name: 'PermissionRequest', agent_id: 'agent-1', tool_name: 'shell' }
      ],
      expect: { state: 'waiting', mainAgent: { state: 'done' } }
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
    // Cancellation survives as the main agent’s verdict while its live shell keeps every lane monitoring.
    // Claude’s inferred cancel must survive the next Stop that lists the shell.
    name: 'interrupted with a watch loop',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] }
      ],
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      }
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
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      }
    }
  },
  {
    // Neither CLI reports cancellation on Stop; keep Orca’s inferred verdict at the late boundary.
    name: 'interrupted, then the late turn boundary',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop' }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }
    },
    codex: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        ORCA_INFERRED_INTERRUPT,
        { hook_event_name: 'Stop' }
      ],
      expect: { state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } }
    }
  },
  {
    // Secondary source: a build that does send `is_interrupt` on its Stop. Same result.
    name: 'interrupted by a Stop that carries is_interrupt, with a watch loop (older builds)',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'Stop', is_interrupt: true, background_tasks: [RUNNING_SHELL] }
      ],
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      }
    }
  },
  {
    // The cancel itself, before any Stop: the row Orca synthesizes must fold the same way.
    name: 'interrupted while a watch loop is already registered',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'start it' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_SHELL] },
        { hook_event_name: 'UserPromptSubmit', prompt: 'now this' },
        ORCA_INFERRED_INTERRUPT
      ],
      expect: {
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done', outcome: 'cancellation' }
      }
    }
  },
  {
    name: 'interrupted with a live subagent',
    claude: {
      events: [
        { hook_event_name: 'UserPromptSubmit', prompt: 'go' },
        { hook_event_name: 'SubagentStart', agent_id: 'agent-1' },
        { hook_event_name: 'Stop', background_tasks: [RUNNING_AGENT] },
        { hook_event_name: 'UserPromptSubmit', prompt: 'and this' },
        ORCA_INFERRED_INTERRUPT
      ],
      expect: { state: 'working', mainAgent: { state: 'done', outcome: 'cancellation' } }
    },
    structured: {
      status: 'idle',
      turnOutcome: 'cancellation',
      backgroundTasks: [AGENT_TASK],
      expect: { state: 'working', mainAgent: { state: 'done', outcome: 'cancellation' } }
    }
  }
]

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
        if (source === 'codex') {
          markCodexLeadTurnInterrupted(state, PANE_KEY)
          continue
        }
        // What the server publishes for the cancel, shaped like the row the lane would build.
        const folded = markClaudeLeadTurnInterrupted(state, PANE_KEY)
        last = { ...(last ?? { prompt: '' }), ...folded, interrupted: folded.state === 'done' }
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

  describe('Claude hook lane', () => {
    it.each(storiesFor('claude'))('%s', (_name, lane) => {
      const payload = drive('claude', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
    })
  })

  describe('structured lane', () => {
    it.each(storiesFor('structured'))('%s', (_name, lane) => {
      const row = structuredAgentSessionAgentStatus({
        status: lane.status,
        childWork: lane.backgroundTasks,
        turnOutcome: lane.turnOutcome
      })
      expect(row).toEqual(lane.expect)
    })
  })

  describe('Grok hook lane', () => {
    it.each(storiesFor('grok'))('%s', (_name, lane) => {
      const payload = drive('grok', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
    })
  })

  describe('Codex hook lane', () => {
    it.each(storiesFor('codex'))('%s', (_name, lane) => {
      const payload = drive('codex', lane.events)
      const row = published(payload)
      expect(row).toEqual(lane.expect)
    })
  })
})
