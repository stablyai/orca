// Replays hook payloads recorded from Claude Code 2.1.287 over a real PTY
// (__fixtures__/claude-task-notification-hooks.jsonl, sidecar beside it). Claude owes the main
// agent one <task-notification> for every background task that ends, and delivers it after the
// task stops running — so "nothing running" is not "finished" (#23942).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from './agent-hook-listener'
import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import {
  clearPaneCacheState,
  createHookListenerState,
  movePaneCacheState
} from './agent-hook-listener/listener-state'
import { cacheRelayLegacyAgentStatus } from './agent-status-legacy-relay-cache'
import { markClaudeLeadTurnInterrupted } from './agent-hook-listener/providers/claude-roster-state'
import { ClaudeOwedNotificationExpiryTimers } from './claude-owed-notification-expiry-timers'
import { CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS } from './claude-owed-task-notifications'
import { makePaneKey } from './stable-pane-id'

type CapturedRecord = {
  scenario: string
  t: number
  kind: 'hook' | 'key'
  payload?: Record<string, unknown>
}

const PANE_KEY = makePaneKey('tab-1', '11111111-1111-4111-8111-111111111111')
const records: CapturedRecord[] = readFileSync(
  join(__dirname, '__fixtures__', 'claude-task-notification-hooks.jsonl'),
  'utf8'
)
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line))
const scenarios = [...new Set(records.map((record) => record.scenario))]

function isTaskNotification(payload: Record<string, unknown>): boolean {
  return (
    payload.hook_event_name === 'UserPromptSubmit' &&
    typeof payload.prompt === 'string' &&
    payload.prompt.startsWith('<task-notification>')
  )
}

/** Pane state after each hook that published one, in capture order. */
function replay(scenario: string): { t: number; index: number; state: string }[] {
  const state = createHookListenerState()
  const published: { t: number; index: number; state: string }[] = []
  records.forEach((record, index) => {
    if (record.scenario !== scenario || !record.payload) {
      return
    }
    const event = normalizeHookPayload(
      state,
      'claude',
      { paneKey: PANE_KEY, payload: record.payload },
      'production'
    )
    if (event && event.payload.sessionBoundary !== true) {
      published.push({ t: record.t, index, state: event.payload.state })
    }
  })
  return published
}

describe('Claude background task notifications', () => {
  const lastNotificationIndexOf = (scenario: string): number =>
    records.findLastIndex(
      (record) =>
        record.scenario === scenario && record.payload && isTaskNotification(record.payload)
    )
  // Why filtered: a scenario with no notification would pass this for any implementation.
  const notifyingScenarios = scenarios.filter((scenario) => lastNotificationIndexOf(scenario) >= 0)

  it.each(notifyingScenarios)(
    '%s: never reads done while a notification is still to come',
    (scenario) => {
      const lastNotificationIndex = lastNotificationIndexOf(scenario)
      const early = replay(scenario).filter(
        (row) => row.state === 'done' && row.index < lastNotificationIndex
      )
      expect(early.map((row) => row.t)).toEqual([])
    }
  )

  it.each(scenarios)('%s: settles to done once everything is delivered', (scenario) => {
    expect(replay(scenario).at(-1)?.state).toBe('done')
  })
})

describe('Claude owed task notifications outside the captures', () => {
  const SESSION = '00000000-0000-4000-8000-000000000000'
  const shell = (id: string) => ({ id, type: 'shell', status: 'running' })

  function listener() {
    const state = createHookListenerState()
    const post = (payload: Record<string, unknown>) =>
      normalizeHookPayload(
        state,
        'claude',
        { paneKey: PANE_KEY, payload: { session_id: SESSION, ...payload } },
        'production'
      )
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'run both' })
    return post
  }

  const launchAgent = (post: (payload: Record<string, unknown>) => unknown, agentId: string) => {
    post({ hook_event_name: 'SubagentStart', agent_id: agentId, agent_type: 'general-purpose' })
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { isAsync: true, status: 'async_launched', agentId }
    })
  }

  it('publishes an owed notification as live work the child list does not show', () => {
    const post = listener()
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })

    const stopped = post({ hook_event_name: 'Stop', background_tasks: [] })

    // A restart seeds a settled main agent only from a row that says no such work exists.
    expect(stopped).toMatchObject({
      claudeRunningNonAgentTask: true,
      payload: { state: 'working' }
    })
    expect(stopped?.payload.subagents).toBeUndefined()
  })

  it('does not announce a turn end the main agent is about to resume from', () => {
    const post = listener()
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })

    // A stamped working row is announced at once; this Stop is ~100 ms from the wake-up turn.
    const owedOnly = post({ hook_event_name: 'Stop', background_tasks: [] })
    expect(owedOnly?.payload.turnCompletedAt).toBeUndefined()

    launchAgent(post, 'a2')
    const childRunning = post({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a2', type: 'subagent', status: 'running' }]
    })
    expect(childRunning?.payload.turnCompletedAt).toEqual(expect.any(Number))
  })

  it('drops what a replaced conversation was owed', () => {
    const post = listener()
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })

    post({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', session_id: 'next-session' })
    const stopped = post({
      hook_event_name: 'Stop',
      background_tasks: [],
      session_id: 'next-session'
    })

    expect(stopped?.payload.state).toBe('done')
  })

  it('owes again when a notified sub-agent resumes by itself and ends a second time', () => {
    const post = listener()
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>'
    })
    post({ hook_event_name: 'Stop', background_tasks: [] })

    // Its own background work ending resumes it: a SubagentStart with no launching tool call.
    post({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })

    expect(post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })?.payload.state).toBe('working')
  })

  it('keeps waiting on a Monitor whose event turns carry no status', () => {
    const post = listener()
    post({ hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_response: { taskId: 'b1' } })
    post({ hook_event_name: 'Stop', background_tasks: [shell('b1')] })
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>\n<task-id>b1</task-id>\n<event>tick 1</event>'
    })

    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('working')
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>'
    })
    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
  })

  it('does not read a Stop that carries no inventory as a shell having ended', () => {
    const post = listener()
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { backgroundTaskId: 'b1' }
    })

    // A Claude build without `background_tasks` says nothing about the shell either way.
    expect(post({ hook_event_name: 'Stop' })?.payload.state).toBe('done')
  })

  it('past its cap forgets a launched task nobody is waiting on, never an owed one', () => {
    const state = createHookListenerState()
    const post = (payload: Record<string, unknown>) =>
      normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    for (let index = 0; index < 300; index += 1) {
      post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, status: 'async_launched', agentId: `a${index + 2}` }
      })
    }

    expect(state.claudeLaunchedBackgroundTasksByPaneKey.get(PANE_KEY)?.size).toBe(256)
    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('working')
  })

  it('at its cap makes room by forgetting a sub-agent already announced', () => {
    const state = createHookListenerState()
    const post = (payload: Record<string, unknown>) =>
      normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    launchAgent(post, 'a1')
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>'
    })
    for (let index = 2; index <= 257; index += 1) {
      post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, status: 'async_launched', agentId: `a${index}` }
      })
    }
    post({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a257', type: 'subagent', status: 'running' }]
    })

    expect(post({ hook_event_name: 'SubagentStop', agent_id: 'a257' })?.payload.state).toBe(
      'working'
    )
  })

  it('owes a vanished shell on a failed turn end too', () => {
    const post = listener()
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { backgroundTaskId: 'b1' }
    })
    post({ hook_event_name: 'Stop', background_tasks: [shell('b1')] })
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'and now?' })

    expect(post({ hook_event_name: 'StopFailure', background_tasks: [] })?.payload.state).toBe(
      'working'
    )
  })

  it('past its cap never forgets a task that is still running', () => {
    const state = createHookListenerState()
    const post = (payload: Record<string, unknown>) =>
      normalizeHookPayload(state, 'claude', { paneKey: PANE_KEY, payload }, 'production')
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'fan out' })
    launchAgent(post, 'a1')
    post({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
    })
    for (let index = 0; index < 300; index += 1) {
      post({
        hook_event_name: 'PostToolUse',
        tool_name: 'Agent',
        tool_response: { isAsync: true, status: 'async_launched', agentId: `a${index + 2}` }
      })
    }
    post({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
    })

    expect(post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })?.payload.state).toBe('working')
  })

  it('does not take a status tag printed by a Monitor for the task having ended', () => {
    const post = listener()
    post({ hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_response: { taskId: 'b1' } })
    post({ hook_event_name: 'Stop', background_tasks: [shell('b1')] })
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt:
        '<task-notification>\n<task-id>b1</task-id>\n<summary>Monitor event: "health"</summary>\n<event><status>up</status></event>'
    })

    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('working')
  })

  it('does not wait on a teammate the roster parks idle, whose turn end is not a finish', () => {
    const post = listener()
    launchAgent(post, 'areviewer-6d3cb5b52120b7bf')
    post({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })
    post({ hook_event_name: 'SubagentStop', agent_id: 'areviewer-6d3cb5b52120b7bf' })

    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
  })
})

describe('Claude owed task notifications that never arrive', () => {
  const SESSION = '00000000-0000-4000-8000-000000000000'
  const MOVED_PANE_KEY = makePaneKey('tab-2', '22222222-2222-4222-8222-222222222222')
  const shell = (id: string) => ({ id, type: 'shell', status: 'running' })
  const LEASE = CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-02T12:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A listener whose host stores each row and restates it at expiry, as main and the relay do. */
  function host() {
    const state = createHookListenerState()
    const restated: AgentHookEventPayload[] = []
    const store = (row: AgentHookEventPayload) =>
      cacheRelayLegacyAgentStatus(state, row, 16, (paneKey) => clearPaneCacheState(state, paneKey))
    const timers = new ClaudeOwedNotificationExpiryTimers(state)
    const publish = (row: AgentHookEventPayload) => {
      restated.push(row)
      store(row)
    }
    const post = (
      payload: Record<string, unknown>,
      paneKey = PANE_KEY,
      body: Record<string, unknown> = {}
    ) => {
      const event = normalizeHookPayload(
        state,
        'claude',
        { paneKey, ...body, payload: { session_id: SESSION, ...payload } },
        'production'
      )
      if (event) {
        store(event)
      }
      timers.arm(paneKey, publish)
      return event
    }
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'start the dev server' })
    return { state, post, restated, timers, store, arm: () => timers.arm(PANE_KEY, publish) }
  }

  /** The main agent launched shell b1, ended its turn, and b1 then vanished unannounced. */
  function shellGoneUnannounced() {
    const h = host()
    h.post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { backgroundTaskId: 'b1' }
    })
    h.post({ hook_event_name: 'Stop', background_tasks: [shell('b1')] })
    h.post({ hook_event_name: 'UserPromptSubmit', prompt: 'thanks' })
    return { ...h, stopped: h.post({ hook_event_name: 'Stop', background_tasks: [] }) }
  }

  it('restates the pane done once an idle main agent was owed for the whole lease', () => {
    const { stopped, restated } = shellGoneUnannounced()
    expect(stopped?.payload.state).toBe('working')

    vi.advanceTimersByTime(LEASE - 1)
    expect(restated).toEqual([])
    vi.advanceTimersByTime(1)

    expect(restated).toHaveLength(1)
    expect(restated[0]).toMatchObject({
      paneKey: PANE_KEY,
      claudeRunningNonAgentTask: false,
      payload: { state: 'done', agentType: 'claude' }
    })
    expect(restated[0].payload.workingMode).toBeUndefined()
  })

  it('waits out the remainder when its timer fires before the wall clock reaches the deadline', () => {
    const { restated } = shellGoneUnannounced()
    const deadline = Date.now() + LEASE
    // Node can run a timer a millisecond early by the wall clock.
    const wallClock = vi.spyOn(Date, 'now').mockReturnValue(deadline - 1)
    vi.advanceTimersByTime(LEASE)
    expect(restated).toEqual([])

    wallClock.mockReturnValue(deadline)
    vi.advanceTimersByTime(1)

    expect(restated.map((row) => row.payload.state)).toEqual(['done'])
    wallClock.mockRestore()
  })

  it("restates under the stored row's launch token and owner, as a row with no hook event", () => {
    const { post, restated } = host()
    const tokened = (payload: Record<string, unknown>) =>
      post(payload, PANE_KEY, { launchToken: 'launch-1' })
    tokened({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_response: { backgroundTaskId: 'b1' }
    })
    tokened({ hook_event_name: 'Stop', background_tasks: [] })

    vi.advanceTimersByTime(LEASE)

    expect(restated[0]).toMatchObject({ launchToken: 'launch-1', payload: { state: 'done' } })
    expect(restated[0].hookEventName).toBeUndefined()
  })

  it('keeps the cancel verdict readable by older clients when a cancelled turn settles', () => {
    const { state, post, restated, store, arm } = host()
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }
    })
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })
    // The server's Ctrl+C inference: the turn is cancelled, the owed notification holds the row.
    const cancelled = markClaudeLeadTurnInterrupted(state, PANE_KEY)
    const row = state.lastStatusByPaneKey.get(PANE_KEY)!
    store({ ...row, payload: { ...row.payload, ...cancelled } })
    arm()
    expect(cancelled.state).toBe('working')

    vi.advanceTimersByTime(LEASE)

    expect(restated[0].payload).toMatchObject({ state: 'done', interrupted: true })
  })

  it('does not run the lease while the main agent is in a turn', () => {
    const { post, restated } = host()
    post({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }
    })
    post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })

    // The notification stays queued behind a long foreground tool.
    vi.advanceTimersByTime(LEASE * 5)
    const stopped = post({ hook_event_name: 'Stop', background_tasks: [] })

    expect(restated).toEqual([])
    expect(stopped?.payload.state).toBe('working')
    vi.advanceTimersByTime(LEASE)
    expect(restated.map((row) => row.payload.state)).toEqual(['done'])
  })

  it('gives a task that ends long after the main agent went idle its own full lease', () => {
    const { post, restated } = host()
    post({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'general-purpose' })
    post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Agent',
      tool_response: { isAsync: true, status: 'async_launched', agentId: 'a1' }
    })
    post({
      hook_event_name: 'Stop',
      background_tasks: [{ id: 'a1', type: 'subagent', status: 'running' }]
    })

    // The reported shape: the sub-agent outlives the main agent's turn by minutes.
    vi.advanceTimersByTime(LEASE * 5)
    const ended = post({ hook_event_name: 'SubagentStop', agent_id: 'a1' })

    expect(ended?.payload.state).toBe('working')
    vi.advanceTimersByTime(LEASE - 1)
    expect(restated).toEqual([])
    vi.advanceTimersByTime(1)
    expect(restated.map((row) => row.payload.state)).toEqual(['done'])
  })

  it('stops waiting on the next hook too, when no timer restated the pane', () => {
    const { post, timers } = shellGoneUnannounced()
    timers.clearAll()
    vi.advanceTimersByTime(LEASE)

    // Claude's prompt-suggestion helper: an unannounced SubagentStop after every main-agent Stop.
    expect(post({ hook_event_name: 'SubagentStop', agent_id: 'ahelper' })?.payload.state).toBe(
      'done'
    )
  })

  it('does not wait again for a notification it already gave up on', () => {
    const { post } = shellGoneUnannounced()
    vi.advanceTimersByTime(LEASE)

    post({ hook_event_name: 'UserPromptSubmit', prompt: 'one more thing' })

    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
  })

  it('says nothing when the notification arrived in time', () => {
    const { post, restated } = shellGoneUnannounced()
    post({
      hook_event_name: 'UserPromptSubmit',
      prompt: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>'
    })
    post({ hook_event_name: 'Stop', background_tasks: [] })

    vi.advanceTimersByTime(LEASE * 2)

    expect(restated).toEqual([])
  })

  it.each([
    [
      'the pane closes',
      (state: ReturnType<typeof createHookListenerState>) => clearPaneCacheState(state, PANE_KEY)
    ],
    ['Claude starts a new session', undefined]
  ] as const)('drops what was owed when %s', (_label, close) => {
    const { state, post, restated } = shellGoneUnannounced()
    if (close) {
      close(state)
    } else {
      post({ hook_event_name: 'SessionStart', source: 'clear' })
    }
    post({ hook_event_name: 'UserPromptSubmit', prompt: 'fresh start' })

    expect(post({ hook_event_name: 'Stop', background_tasks: [] })?.payload.state).toBe('done')
    vi.advanceTimersByTime(LEASE)
    expect(restated).toEqual([])
  })

  it('keeps what is owed when the pane moves to another key', () => {
    const { state, post } = shellGoneUnannounced()
    movePaneCacheState(state, PANE_KEY, MOVED_PANE_KEY)

    expect(
      post({ hook_event_name: 'SubagentStop', agent_id: 'ahelper' }, MOVED_PANE_KEY)?.payload.state
    ).toBe('working')
  })
})
