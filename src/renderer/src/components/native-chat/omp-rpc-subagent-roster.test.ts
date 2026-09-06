import { describe, expect, it } from 'vitest'
import type {
  OmpRpcSubagentEventPayload,
  OmpRpcSubagentLifecyclePayload,
  OmpRpcSubagentProgressPayload
} from '../../../../shared/omp-rpc-subagent-protocol'
import {
  ompRpcSubagentRosterText,
  reduceOmpRpcSubagentEvent,
  reduceOmpRpcSubagentLifecycle,
  reduceOmpRpcSubagentProgress,
  SUBAGENT_EVENT_TEXT_TAIL_CHARS,
  type OmpRpcSubagentRosterEntry
} from './omp-rpc-subagent-roster'

function lifecycle(
  overrides: Partial<OmpRpcSubagentLifecyclePayload> = {}
): OmpRpcSubagentLifecyclePayload {
  return { id: 'sa-1', index: 0, agent: 'explorer', status: 'started', ...overrides }
}

function progress(
  overrides: Partial<OmpRpcSubagentProgressPayload> = {}
): OmpRpcSubagentProgressPayload {
  return {
    index: 0,
    agent: 'explorer',
    task: 'map the auth flow',
    progress: {
      id: 'sa-1',
      index: 0,
      agent: 'explorer',
      status: 'running',
      task: 'map the auth flow'
    },
    ...overrides
  }
}

function childEvent(
  event: Record<string, unknown> & { type: string },
  id = 'sa-1'
): OmpRpcSubagentEventPayload {
  return { id, event }
}

function textDelta(delta: string): Record<string, unknown> & { type: string } {
  return { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } }
}

function assistantMessage(text: string, timestamp?: number): Record<string, unknown> {
  return {
    role: 'assistant',
    content: text === '' ? [] : [{ type: 'text', text }],
    ...(timestamp === undefined ? {} : { timestamp })
  }
}

/** A streaming delta as upstream pushes it: the delta half plus the accumulated
 *  partial, which carries the message's own `timestamp`. */
function stampedTextDelta(
  delta: string,
  timestamp: number,
  accumulated = delta
): Record<string, unknown> & { type: string } {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
    message: assistantMessage(accumulated, timestamp)
  }
}

describe('reduceOmpRpcSubagentLifecycle', () => {
  // Upstream maps lifecycle `started` onto AgentProgress `running`
  // (rpc-subagents.ts statusFromLifecycle); mirroring that keeps one status
  // vocabulary across both frame families.
  it('opens a running entry on `started`', () => {
    const roster = reduceOmpRpcSubagentLifecycle([], lifecycle({ description: 'scout' }))
    expect(roster).toEqual([
      {
        id: 'sa-1',
        index: 0,
        agent: 'explorer',
        status: 'running',
        description: 'scout',
        task: undefined,
        currentTool: undefined,
        toolCount: undefined,
        parentToolCallId: undefined
      }
    ])
  })

  it('records the terminal status in place rather than dropping the entry', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const ended = reduceOmpRpcSubagentLifecycle(started, lifecycle({ status: 'completed' }))
    expect(ended).toHaveLength(1)
    expect(ended[0].status).toBe('completed')
  })

  // A finished subagent is running nothing, so a terminal frame must not carry
  // the last tool forward into the row's final state.
  it('drops the current tool when the subagent reaches a terminal status', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const working = reduceOmpRpcSubagentEvent(
      started,
      childEvent({ type: 'tool_execution_start', toolName: 'grep', toolCallId: 'c1' })
    )
    const ended = reduceOmpRpcSubagentLifecycle(working, lifecycle({ status: 'completed' }))
    expect(ended[0].currentTool).toBeUndefined()
  })

  // Upstream refuses a lifecycle frame for an unknown id unless it is a start
  // (`if (!existing && payload.status !== "started") return`).
  it('ignores a terminal lifecycle frame for an unknown subagent', () => {
    expect(reduceOmpRpcSubagentLifecycle([], lifecycle({ status: 'failed' }))).toEqual([])
  })

  // Upstream `hasSameOwner`: a frame whose parentToolCallId contradicts the
  // tracked one belongs to a different spawn and must not overwrite it.
  it('ignores a frame whose parentToolCallId contradicts the tracked entry', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle({ parentToolCallId: 'call-a' }))
    const other = reduceOmpRpcSubagentLifecycle(
      started,
      lifecycle({ status: 'aborted', parentToolCallId: 'call-b' })
    )
    expect(other[0].status).toBe('running')
  })
})

describe('reduceOmpRpcSubagentProgress', () => {
  it('updates the tracked entry with the latest progress', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const updated = reduceOmpRpcSubagentProgress(
      started,
      progress({
        progress: {
          id: 'sa-1',
          index: 0,
          agent: 'explorer',
          status: 'running',
          task: 'map the auth flow',
          currentTool: 'grep',
          toolCount: 4
        }
      })
    )
    expect(updated[0]).toMatchObject({
      id: 'sa-1',
      task: 'map the auth flow',
      currentTool: 'grep',
      toolCount: 4,
      status: 'running'
    })
  })

  // Upstream clears `progress.currentTool` on `tool_execution_end` and
  // force-flushes that snapshot (executor.ts tool_execution_end case), so an
  // absent currentTool means "no tool running", not "unchanged".
  it('clears currentTool when a progress snapshot omits it', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const running = reduceOmpRpcSubagentProgress(
      started,
      progress({
        progress: {
          id: 'sa-1',
          index: 0,
          agent: 'explorer',
          status: 'running',
          task: 'map the auth flow',
          currentTool: 'grep',
          toolCount: 4
        }
      })
    )
    const idle = reduceOmpRpcSubagentProgress(running, progress())
    expect(idle[0].currentTool).toBeUndefined()
    expect(idle[0].toolCount).toBe(4)
  })

  // Upstream drops progress for an id it never saw start (`if (!existing) return`).
  it('ignores progress for a subagent that never started', () => {
    expect(reduceOmpRpcSubagentProgress([], progress())).toEqual([])
  })

  // A detached spawn outlives the turn that started it, so the roster has to
  // record which entries are detached for the turn boundary to spare them.
  it('records a detached spawn from either frame family', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle({ detached: true }))
    expect(started[0].detached).toBe(true)
    const advanced = reduceOmpRpcSubagentProgress(started, progress())
    expect(advanced[0].detached).toBe(true)
  })
})

describe('reduceOmpRpcSubagentEvent', () => {
  it('projects a child text delta onto the tracked entry', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = reduceOmpRpcSubagentEvent(started, childEvent(textDelta('reading auth.ts')))
    expect(roster[0].latestText).toBe('reading auth.ts')
  })

  it('appends successive deltas and retains only the tail', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [textDelta('a'.repeat(SUBAGENT_EVENT_TEXT_TAIL_CHARS)), textDelta('bcd')].reduce(
      (current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)),
      started
    )
    expect(roster[0].latestText).toHaveLength(SUBAGENT_EVENT_TEXT_TAIL_CHARS)
    expect(roster[0].latestText?.endsWith('bcd')).toBe(true)
  })

  it('names the tool a child tool_execution_start reports', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = reduceOmpRpcSubagentEvent(
      started,
      childEvent({ type: 'tool_execution_start', toolName: 'grep', toolCallId: 'c1' })
    )
    expect(roster[0].currentTool).toBe('grep')
  })

  it('clears the current tool when the child reports tool_execution_end', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [
      { type: 'tool_execution_start', toolName: 'grep', toolCallId: 'c1' },
      { type: 'tool_execution_end', toolName: 'grep', toolCallId: 'c1' }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(roster[0].currentTool).toBeUndefined()
  })

  // Same admission rule as progress: an event is not a spawn record, so it
  // cannot open a roster row for an id nothing announced.
  it('ignores an event for a subagent that never started', () => {
    expect(reduceOmpRpcSubagentEvent([], childEvent(textDelta('hi')))).toEqual([])
  })

  it('leaves the roster identical for a child event with nothing to project', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    expect(reduceOmpRpcSubagentEvent(started, childEvent({ type: 'turn_start' }))).toBe(started)
  })

  // Canonical `message_update` always carries the accumulated `message`; the
  // delta is the optional half. A subscriber that only reads deltas keeps
  // rendering the previous message forever.
  it('replaces the retained tail from a full-content assistant message_update', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [
      textDelta('old'),
      { type: 'message_update', message: assistantMessage('fresh') }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(roster[0].latestText).toBe('fresh')
  })

  it('retains only the tail of an oversized full-content assistant message', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = reduceOmpRpcSubagentEvent(
      started,
      childEvent({
        type: 'message_update',
        message: assistantMessage(`${'x'.repeat(SUBAGENT_EVENT_TEXT_TAIL_CHARS)}bcd`)
      })
    )
    expect(roster[0].latestText).toHaveLength(SUBAGENT_EVENT_TEXT_TAIL_CHARS)
    expect(roster[0].latestText?.endsWith('bcd')).toBe(true)
  })

  // A start frame is NOT proof of a newer message: upstream emits
  // `message_update` straight to subscribers but gates every other session
  // event behind its async extension emit and a FIFO fan-out ticket
  // (agent-session.ts #emitSessionEvent), so an extension that awaits inside a
  // `message_start` handler delivers that start after its own message's
  // updates. Resetting then would erase the child's finished output.
  it('keeps text a message_update already projected when its own message_start lands late', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const projected = [
      stampedTextDelta('old', 10),
      { type: 'message_update', message: assistantMessage('new', 20) },
      { type: 'message_start', message: assistantMessage('', 20) }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(projected[0].latestText).toBe('new')
  })

  // The same reordering the other way round: a newer message's first delta can
  // precede its own start, so the delta must not concatenate onto the previous
  // message's tail.
  it('starts a newer message’s tail fresh when its first delta precedes its message_start', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const streamed = [stampedTextDelta('old', 10), stampedTextDelta('new', 20)].reduce(
      (current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)),
      started
    )
    expect(streamed[0].latestText).toBe('new')
  })

  // `AssistantMessage.timestamp` is documented as a Unix ms wall clock
  // (packages/ai/src/types.ts) and nothing else — not a message id and not a
  // sequence. Two messages minted inside one clock tick therefore carry the
  // same value, so it can never be read as identity.
  it('replaces the retained tail for a distinct message sharing the previous clock tick', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [
      stampedTextDelta('old', 1000),
      { type: 'message_start', message: assistantMessage('', 1000) },
      stampedTextDelta('new', 1000)
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(roster[0].latestText).toBe('new')
  })

  // The same clock is not monotonic either: an NTP step or a subagent running
  // on another host can stamp a genuinely newer message with a lower value,
  // and discarding it would freeze the row on text the child already replaced.
  it('projects a newer message whose message clock ran backwards', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [stampedTextDelta('old', 1000), stampedTextDelta('new', 999)].reduce(
      (current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)),
      started
    )
    expect(roster[0].latestText).toBe('new')
  })

  // A start carries no id, so it cannot prove a NEW message versus a late one
  // and never rewrites the retained text. What it does end is the only
  // boundary a snapshot-less delta run has: the next delta opens a fresh tail
  // instead of gluing onto the message the start superseded.
  it('opens a fresh tail for the deltas that follow an assistant message_start', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const restarted = [
      textDelta('old'),
      { type: 'message_start', message: assistantMessage('') }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    const streamed = reduceOmpRpcSubagentEvent(restarted, childEvent(textDelta('new')))
    expect(streamed[0].latestText).toBe('new')
  })

  // message_start is emitted for user and toolResult messages too; only an
  // assistant message supersedes the text the row is showing.
  it('keeps the retained tail across a non-assistant message_start', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [
      textDelta('reading auth.ts'),
      {
        type: 'message_start',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] }
      }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(roster[0].latestText).toBe('reading auth.ts')
  })

  // OMP echoes the user's own turn through message_update with no
  // assistantMessageEvent (verified live); that echo is not child output.
  it('ignores the user-echo message_update', () => {
    const started = reduceOmpRpcSubagentLifecycle([], lifecycle())
    const roster = [
      textDelta('reading auth.ts'),
      { type: 'message_update', message: { role: 'user', content: [{ type: 'text', text: 'go' }] } }
    ].reduce((current, event) => reduceOmpRpcSubagentEvent(current, childEvent(event)), started)
    expect(roster[0].latestText).toBe('reading auth.ts')
  })
})

describe('ompRpcSubagentRosterText', () => {
  const entries: OmpRpcSubagentRosterEntry[] = [
    {
      id: 'sa-1',
      index: 0,
      agent: 'explorer',
      status: 'running',
      task: 'map the auth flow',
      description: undefined,
      currentTool: 'grep',
      toolCount: 4,
      parentToolCallId: undefined,
      detached: undefined,
      latestText: undefined,
      latestTextAcceptsDelta: undefined
    },
    {
      id: 'sa-2',
      index: 1,
      agent: 'reviewer',
      status: 'completed',
      task: undefined,
      description: 'review the diff',
      currentTool: undefined,
      toolCount: undefined,
      parentToolCallId: undefined,
      detached: undefined,
      latestText: undefined,
      latestTextAcceptsDelta: undefined
    }
  ]

  it('renders one line per subagent, ordered by index', () => {
    expect(ompRpcSubagentRosterText(entries)).toBe(
      [
        '※ subagents',
        '· explorer — running · map the auth flow · grep (4 tools)',
        '· reviewer — completed · review the diff'
      ].join('\n')
    )
  })

  // The retained tail can straddle several child lines; only the newest one is
  // still true of what the subagent is doing now.
  it('renders the newest line of a child event stream as the entry’s last fact', () => {
    const [first] = entries
    expect(
      ompRpcSubagentRosterText([{ ...first, latestText: 'older line\nreading auth.ts\n' }])
    ).toBe(
      [
        '※ subagents',
        '· explorer — running · map the auth flow · grep (4 tools) · reading auth.ts'
      ].join('\n')
    )
  })

  it('renders nothing for an empty roster', () => {
    expect(ompRpcSubagentRosterText([])).toBe('')
  })
})
