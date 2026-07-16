import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  markClaudeLeadTurnInterrupted,
  movePaneCacheState,
  normalizeHookPayload,
  seedAgentSubagentLifecycleFromSnapshots,
  type HookListenerState
} from './agent-hook-listener'
import { AGENT_STATUS_MAX_SUBAGENTS } from './agent-status-types'
import { makePaneKey } from './stable-pane-id'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const MOVED_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_LEAF_ID = '33333333-3333-4333-8333-333333333333'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const MOVED_PANE_KEY = makePaneKey('tab-moved', MOVED_LEAF_ID)
const OTHER_PANE_KEY = makePaneKey('tab-other', OTHER_LEAF_ID)

describe('agent subagent lifecycle', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const codexEvent = (
    payload: Record<string, unknown>,
    paneKey: string = PANE_KEY
  ): ReturnType<typeof normalizeHookPayload> =>
    normalizeHookPayload(state, 'codex', { paneKey, payload }, 'production')

  const providerEvent = (
    source: 'claude' | 'copilot' | 'opencode' | 'mimo-code',
    payload: Record<string, unknown>,
    paneKey: string = PANE_KEY
  ): ReturnType<typeof normalizeHookPayload> =>
    normalizeHookPayload(state, source, { paneKey, payload }, 'production')

  it('gates a lead Stop until every child drains and accepts child Stop as a finish signal', () => {
    codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'review the pull request' })
    codexEvent({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm test' }
    })
    codexEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'reviewer-1',
      agent_type: 'code-reviewer'
    })
    const secondChild = codexEvent({
      hook_event_name: 'SubagentStart',
      agentId: 'reviewer-2',
      agentType: 'test-reviewer'
    })
    expect(secondChild?.toolAgentId).toBe('reviewer-2')
    expect(secondChild?.toolAgentType).toBe('test-reviewer')

    // Why: a lead event has no agent_id. Its Stop owns lead state, but a live
    // child keeps the effective pane state working until that roster drains.
    const leadStop = codexEvent({ hook_event_name: 'Stop' })
    expect(leadStop?.payload).toMatchObject({
      state: 'working',
      leadState: 'done',
      prompt: 'review the pull request',
      toolName: 'Bash',
      toolInput: 'pnpm test'
    })
    expect(leadStop?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'reviewer-1', agentType: 'code-reviewer' }),
      expect.objectContaining({ id: 'reviewer-2', agentType: 'test-reviewer' })
    ])

    // Codex normal child events carry agent_id. Treat a child Stop as child
    // completion instead of letting it overwrite the already-done lead.
    const afterFirst = codexEvent({ hook_event_name: 'Stop', agent_id: 'reviewer-1' })
    expect(afterFirst?.payload.state).toBe('working')
    expect(afterFirst?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'reviewer-2', state: 'working' })
    ])

    const drained = codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'reviewer-2' })
    expect(drained?.payload.state).toBe('done')
    expect(drained?.payload.prompt).toBe('review the pull request')
    expect(drained?.payload.toolName).toBe('Bash')
    expect(drained?.payload.subagents).toBeUndefined()
  })

  it('preserves the lead prompt, tool, and state across child-origin activity', () => {
    codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'lead prompt' })
    codexEvent({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm lint' }
    })

    const childTool = codexEvent({
      hook_event_name: 'PreToolUse',
      agent_id: 'child-1',
      agent_type: 'worker',
      prompt: 'child prompt',
      tool_name: 'Read',
      tool_input: { file_path: 'src/child.ts' }
    })
    expect(childTool?.payload).toMatchObject({
      state: 'waiting',
      prompt: 'lead prompt',
      toolName: 'Bash',
      toolInput: 'pnpm lint'
    })

    // A no-id PostToolUse is lead-owned and may advance the lead out of its
    // permission wait even though a child remains live.
    const leadPost = codexEvent({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'pnpm lint' }
    })
    expect(leadPost?.payload.state).toBe('working')
    expect(leadPost?.payload.toolName).toBe('Bash')
    expect(leadPost?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'child-1', state: 'working' })
    ])
  })

  it('mutates the roster only for recognized child events carrying an id', () => {
    codexEvent({ hook_event_name: 'Stop' })

    expect(
      codexEvent({
        hook_event_name: 'UnknownTelemetry',
        agent_id: 'unknown-child',
        agent_type: 'worker'
      })
    ).toBeNull()
    expect(codexEvent({ hook_event_name: 'SubagentStart' })).toBeNull()
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.size).toBe(0)

    const recognized = codexEvent({
      hook_event_name: 'PreToolUse',
      agent_id: 'known-child',
      agent_type: 'worker'
    })
    expect(recognized?.payload.state).toBe('working')
    expect(recognized?.payload.subagents).toEqual([expect.objectContaining({ id: 'known-child' })])

    // The same event without an id is lead-owned. It records lead done while
    // the roster gate keeps the visible status working.
    const leadStop = codexEvent({ hook_event_name: 'Stop' })
    expect(leadStop?.payload.state).toBe('working')
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.leadState).toBe('done')

    expect(
      codexEvent({ hook_event_name: 'UnknownTelemetry', agent_id: 'second-unknown' })
    ).toBeNull()
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.has('second-unknown')).toBe(
      false
    )
  })

  it('keeps waiting while any concurrent child permission remains unresolved', () => {
    codexEvent({ hook_event_name: 'Stop' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-a' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'child-b' })

    expect(
      codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'child-a' })?.payload.state
    ).toBe('waiting')
    expect(
      codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'child-b' })?.payload.state
    ).toBe('waiting')
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.waitingSubagentIds).toEqual(
      new Set(['child-a', 'child-b'])
    )

    const firstResumed = codexEvent({ hook_event_name: 'PostToolUse', agent_id: 'child-a' })
    expect(firstResumed?.payload.state).toBe('waiting')
    expect(firstResumed?.payload.waitingSubagentIds).toEqual(['child-b'])
    const firstStopped = codexEvent({ hook_event_name: 'Stop', agent_id: 'child-a' })
    expect(firstStopped?.payload.state).toBe('waiting')

    const secondResumed = codexEvent({ hook_event_name: 'PostToolUse', agent_id: 'child-b' })
    expect(secondResumed?.payload.state).toBe('working')
    const drained = codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'child-b' })
    expect(drained?.payload.state).toBe('done')
  })

  it('resets stale child state on a new lead SessionStart', () => {
    codexEvent({ hook_event_name: 'Stop' })
    codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'stale-child' })

    const sessionStart = codexEvent({ hook_event_name: 'SessionStart' })
    expect(sessionStart?.payload.state).toBe('working')
    expect(sessionStart?.payload.subagents).toBeUndefined()
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.size).toBe(0)
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.waitingSubagentIds.size).toBe(0)

    expect(codexEvent({ hook_event_name: 'Stop' })?.payload.state).toBe('done')
  })

  it('preserves live children and waits across an in-place compact SessionStart', () => {
    codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'orchestrate review' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'compact-child-a' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'compact-child-b' })
    codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'compact-child-a' })

    const compact = codexEvent({ hook_event_name: 'SessionStart', source: 'compact' })
    expect(compact?.payload.state).toBe('waiting')
    expect(compact?.payload.prompt).toBe('orchestrate review')
    expect(compact?.payload.subagents).toEqual([
      expect.objectContaining({ id: 'compact-child-a' }),
      expect.objectContaining({ id: 'compact-child-b' })
    ])

    codexEvent({ hook_event_name: 'PostToolUse', agent_id: 'compact-child-a' })
    const leadStop = codexEvent({ hook_event_name: 'Stop' })
    expect(leadStop?.payload).toMatchObject({ state: 'working', leadState: 'done' })
    expect(leadStop?.payload.subagents).toHaveLength(2)

    expect(
      codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'compact-child-a' })?.payload.state
    ).toBe('working')
    expect(
      codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'compact-child-b' })?.payload.state
    ).toBe('done')
  })

  it('keeps pane lifecycle state isolated and moves or clears it with the pane', () => {
    codexEvent({ hook_event_name: 'Stop' })
    codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'moving-child' })
    expect(codexEvent({ hook_event_name: 'Stop' }, OTHER_PANE_KEY)?.payload.state).toBe('done')

    movePaneCacheState(state, PANE_KEY, MOVED_PANE_KEY)
    expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.agentSubagentLifecycleByPaneKey.has(MOVED_PANE_KEY)).toBe(true)
    expect(state.agentLifecycleOwnerByPaneKey.has(PANE_KEY)).toBe(false)
    expect(state.agentLifecycleOwnerByPaneKey.get(MOVED_PANE_KEY)?.source).toBe('codex')
    expect(state.agentSubagentLifecycleByPaneKey.get(MOVED_PANE_KEY)?.waitingSubagentIds.size).toBe(
      1
    )

    const resumed = codexEvent(
      { hook_event_name: 'PostToolUse', agent_id: 'moving-child' },
      MOVED_PANE_KEY
    )
    expect(resumed?.payload.state).toBe('working')
    expect(codexEvent({ hook_event_name: 'Stop' }, OTHER_PANE_KEY)?.payload.state).toBe('done')

    clearPaneCacheState(state, MOVED_PANE_KEY)
    expect(state.agentSubagentLifecycleByPaneKey.has(MOVED_PANE_KEY)).toBe(false)
    expect(state.agentLifecycleOwnerByPaneKey.has(MOVED_PANE_KEY)).toBe(false)

    clearAllListenerCaches(state)
    expect(state.agentLifecycleOwnerByPaneKey.size).toBe(0)
  })

  it('restores only working children from persisted snapshots', () => {
    seedAgentSubagentLifecycleFromSnapshots(
      state,
      PANE_KEY,
      'codex',
      [
        { id: 'restored-working', state: 'working', startedAt: 123, agentType: 'reviewer' },
        { id: 'restored-idle', state: 'idle', startedAt: 456, agentType: 'researcher' }
      ],
      { leadState: 'done' }
    )

    const childActivity = codexEvent({
      hook_event_name: 'PreToolUse',
      agent_id: 'restored-working'
    })
    expect(childActivity?.payload).toMatchObject({ state: 'working', leadState: 'done' })
    expect(childActivity?.payload.subagents).toEqual([
      {
        id: 'restored-working',
        state: 'working',
        startedAt: 123,
        agentType: 'reviewer',
        description: undefined
      }
    ])

    const drained = codexEvent({
      hook_event_name: 'SubagentStop',
      agent_id: 'restored-working'
    })
    expect(drained?.payload.state).toBe('done')
  })

  it('restores concurrent child wait ownership without letting unrelated churn clear it', () => {
    codexEvent({ hook_event_name: 'Stop' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'restored-wait-a' })
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'restored-wait-b' })
    codexEvent({ hook_event_name: 'PermissionRequest', agent_id: 'restored-wait-a' })
    const waiting = codexEvent({
      hook_event_name: 'PermissionRequest',
      agent_id: 'restored-wait-b'
    })!
    expect(waiting.payload.waitingSubagentIds).toEqual(['restored-wait-a', 'restored-wait-b'])

    state = createHookListenerState()
    seedAgentSubagentLifecycleFromSnapshots(state, PANE_KEY, 'codex', waiting.payload.subagents!, {
      leadState: waiting.payload.leadState,
      waitingSubagentIds: waiting.payload.waitingSubagentIds
    })

    const firstResumed = codexEvent({
      hook_event_name: 'PostToolUse',
      agent_id: 'restored-wait-a'
    })
    expect(firstResumed?.payload.state).toBe('waiting')
    expect(firstResumed?.payload.waitingSubagentIds).toEqual(['restored-wait-b'])
    expect(
      codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'restored-wait-a' })?.payload.state
    ).toBe('waiting')

    expect(
      codexEvent({ hook_event_name: 'PostToolUse', agent_id: 'restored-wait-b' })?.payload.state
    ).toBe('working')
    expect(
      codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'restored-wait-b' })?.payload.state
    ).toBe('done')
  })

  it('keeps legacy hydrated children conservative until the next lead hook', () => {
    // Older last-status payloads have no leadState. Their effective working
    // state cannot prove whether the lead or only its child was working.
    seedAgentSubagentLifecycleFromSnapshots(state, PANE_KEY, 'codex', [
      { id: 'legacy-child', state: 'working', startedAt: 123 }
    ])

    const drained = codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'legacy-child' })
    expect(drained?.payload.state).toBe('working')
    expect(drained?.payload.subagents).toBeUndefined()
    // The conservative fallback is not sticky once real lead evidence arrives.
    expect(codexEvent({ hook_event_name: 'Stop' })?.payload.state).toBe('done')
  })

  it('rejects invisible over-cap children so they cannot gate or own waiting state', () => {
    codexEvent({ hook_event_name: 'Stop' })
    const overlong = codexEvent({
      hook_event_name: 'SubagentStart',
      agent_id: 'x'.repeat(65)
    })
    expect(overlong?.payload.state).toBe('done')
    expect(overlong?.payload.subagents).toBeUndefined()

    const childIds = Array.from(
      { length: AGENT_STATUS_MAX_SUBAGENTS },
      (_, index) => `child-${String(index).padStart(2, '0')}`
    )
    for (const agentId of childIds) {
      codexEvent({ hook_event_name: 'SubagentStart', agent_id: agentId })
    }
    const overflow = codexEvent({
      hook_event_name: 'PermissionRequest',
      agent_id: 'overflow-child'
    })
    expect(overflow?.payload.state).toBe('working')
    expect(overflow?.payload.subagents).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)
    expect(overflow?.payload.subagents?.some(({ id }) => id === 'overflow-child')).toBe(false)

    let last: ReturnType<typeof codexEvent> = null
    for (const agentId of childIds) {
      last = codexEvent({ hook_event_name: 'SubagentStop', agent_id: agentId })
    }
    expect(last?.payload.state).toBe('done')
  })

  it('preserves the original six-event behavior for payloads without child fields', () => {
    expect(codexEvent({ hook_event_name: 'SessionStart' })?.payload.state).toBe('working')
    const prompt = codexEvent({ hook_event_name: 'UserPromptSubmit', prompt: 'legacy turn' })
    expect(prompt?.payload).toMatchObject({ state: 'working', prompt: 'legacy turn' })
    const preTool = codexEvent({
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      tool_input: { file_path: 'src/index.ts' }
    })
    expect(preTool?.payload).toMatchObject({
      state: 'working',
      toolName: 'Read',
      toolInput: 'src/index.ts'
    })
    expect(codexEvent({ hook_event_name: 'PermissionRequest' })?.payload.state).toBe('waiting')
    expect(codexEvent({ hook_event_name: 'PostToolUse' })?.payload.state).toBe('working')
    const stop = codexEvent({ hook_event_name: 'Stop' })
    expect(stop?.payload.state).toBe('done')
    expect(stop?.payload.leadState).toBeUndefined()
    expect(stop?.payload.subagents).toBeUndefined()
  })

  it('tracks concurrent same-name Copilot children by opaque transcript identity', () => {
    providerEvent('copilot', { hook_event_name: 'sessionStart' })
    providerEvent('copilot', {
      hook_event_name: 'subagentStart',
      transcriptPath: 'C:\\sessions\\first-reviewer.jsonl',
      agentName: 'reviewer',
      agentDisplayName: 'PR reviewer',
      agentDescription: 'Review the API changes'
    })
    const second = providerEvent('copilot', {
      hook_event_name: 'subagentStart',
      transcriptPath: 'C:\\sessions\\second-reviewer.jsonl',
      agentName: 'reviewer',
      agentDisplayName: 'PR reviewer',
      agentDescription: 'Review the tests'
    })

    expect(second?.payload.subagents).toHaveLength(2)
    const ids = second?.payload.subagents?.map(({ id }) => id) ?? []
    expect(new Set(ids).size).toBe(2)
    expect(ids).toEqual([
      expect.stringMatching(/^copilot:[a-f0-9]{32}$/),
      expect.stringMatching(/^copilot:[a-f0-9]{32}$/)
    ])
    expect(second?.payload.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentType: 'reviewer', description: 'Review the API changes' }),
        expect.objectContaining({ agentType: 'reviewer', description: 'Review the tests' })
      ])
    )

    const leadStop = providerEvent('copilot', { hook_event_name: 'agentStop' })
    expect(leadStop?.payload).toMatchObject({ state: 'working', leadState: 'done' })
    const afterFirst = providerEvent('copilot', {
      hook_event_name: 'SubagentStop',
      transcript_path: 'C:\\sessions\\first-reviewer.jsonl',
      agent_name: 'reviewer'
    })
    expect(afterFirst?.payload.subagents).toHaveLength(1)
    const drained = providerEvent('copilot', {
      hook_event_name: 'SubagentStop',
      transcriptPath: 'C:\\sessions\\second-reviewer.jsonl',
      agentName: 'reviewer'
    })
    expect(drained?.payload.state).toBe('done')
    expect(drained?.payload.subagents).toBeUndefined()
  })

  it('ignores malformed Copilot lifecycle identity without creating hidden state', () => {
    expect(
      providerEvent('copilot', {
        hook_event_name: 'subagentStart',
        agentName: 'missing-transcript'
      })
    ).toBeNull()
    expect(
      providerEvent('copilot', {
        hook_event_name: 'subagentStart',
        transcriptPath: 'x'.repeat(4_097),
        agentName: 'oversized-transcript'
      })
    ).toBeNull()
    expect(
      providerEvent('copilot', {
        hook_event_name: 'SubagentStop',
        transcript_path: 42
      })
    ).toBeNull()
    expect(state.agentSubagentLifecycleByPaneKey.has(PANE_KEY)).toBe(false)
  })

  it('resets provider-owned child state when a reused pane starts another agent', () => {
    codexEvent({ hook_event_name: 'SubagentStart', agent_id: 'codex-child' })
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    codexEvent({ hook_event_name: 'Stop' })
    expect(
      codexEvent({ hook_event_name: 'SubagentStop', agent_id: 'codex-child' })?.payload.state
    ).toBe('done')

    const copilotStart = providerEvent('copilot', { hook_event_name: 'sessionStart' })
    expect(copilotStart?.payload.subagents).toBeUndefined()
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.source).toBe('copilot')
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.size).toBe(0)

    providerEvent('copilot', {
      hook_event_name: 'subagentStart',
      transcriptPath: '/sessions/copilot-child.jsonl',
      agentName: 'researcher'
    })
    providerEvent('copilot', { hook_event_name: 'agentStop' })
    expect(
      providerEvent('copilot', {
        hook_event_name: 'SubagentStop',
        transcriptPath: '/sessions/copilot-child.jsonl'
      })?.payload.state
    ).toBe('done')
    const codexStart = codexEvent({ hook_event_name: 'SessionStart' })
    expect(codexStart?.payload.subagents).toBeUndefined()
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.source).toBe('codex')
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.size).toBe(0)
  })

  it('preserves Copilot children through pre-compaction without treating it as a new session', () => {
    providerEvent('copilot', {
      hook_event_name: 'subagentStart',
      transcriptPath: '/sessions/compacting-child.jsonl',
      agentName: 'researcher'
    })
    expect(providerEvent('copilot', { hook_event_name: 'preCompact' })).toBeNull()
    const stopped = providerEvent('copilot', { hook_event_name: 'agentStop' })
    expect(stopped?.payload).toMatchObject({ state: 'working', leadState: 'done' })
    expect(stopped?.payload.subagents).toHaveLength(1)
  })

  it.each(['opencode', 'mimo-code'] as const)(
    'gates %s root idle on normalized provider child lifecycle events',
    (source) => {
      providerEvent(source, { hook_event_name: 'SessionBusy', prompt: 'delegate work' })
      const started = providerEvent(source, {
        hook_event_name: 'SubagentStart',
        child_id: 'provider-child-session-1',
        agent_type: 'reviewer',
        description: 'Review delegated changes'
      })
      expect(started?.payload.subagents).toEqual([
        expect.objectContaining({
          id: expect.stringMatching(new RegExp(`^${source}:[a-f0-9]{32}$`)),
          agentType: 'reviewer',
          description: 'Review delegated changes'
        })
      ])

      const idle = providerEvent(source, { hook_event_name: 'SessionIdle' })
      expect(idle?.payload).toMatchObject({ state: 'working', leadState: 'done' })
      const drained = providerEvent(source, {
        hook_event_name: 'SubagentStop',
        childId: 'provider-child-session-1'
      })
      expect(drained?.payload.state).toBe('done')
      expect(drained?.payload.subagents).toBeUndefined()
    }
  )

  it('hydrates an arbitrary compatible provider through the generic lifecycle API', () => {
    seedAgentSubagentLifecycleFromSnapshots(
      state,
      PANE_KEY,
      'custom-orca-agent',
      [
        {
          id: 'opaque-custom-child',
          state: 'working',
          startedAt: 321,
          agentType: 'reviewer',
          description: 'Custom review'
        }
      ],
      { leadState: 'done', leadInterrupted: true }
    )

    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)).toMatchObject({
      source: 'custom-orca-agent',
      leadState: 'done',
      leadInterrupted: true
    })
    expect(state.agentSubagentLifecycleByPaneKey.get(PANE_KEY)?.roster.size).toBe(1)
  })

  it('persists Claude underlying done through a child wait and resolves it after restart', () => {
    providerEvent('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'review' })
    providerEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'claude-waiting-child',
      agent_type: 'reviewer'
    })
    providerEvent('claude', { hook_event_name: 'Stop' })
    const waiting = providerEvent('claude', {
      hook_event_name: 'PermissionRequest',
      agent_id: 'claude-waiting-child',
      agent_type: 'reviewer'
    })
    expect(waiting?.payload).toMatchObject({ state: 'waiting', leadState: 'done' })
    expect(waiting?.payload.waitingSubagentIds).toEqual(['claude-waiting-child'])

    state = createHookListenerState()
    seedAgentSubagentLifecycleFromSnapshots(
      state,
      PANE_KEY,
      'claude',
      waiting!.payload.subagents!,
      {
        leadState: waiting!.payload.leadState,
        leadInterrupted: waiting!.payload.leadInterrupted,
        waitingSubagentIds: waiting!.payload.waitingSubagentIds
      }
    )
    const unrelated = providerEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'claude-unrelated-child'
    })
    expect(unrelated?.payload.state).toBe('waiting')
    expect(unrelated?.payload.waitingSubagentIds).toEqual(['claude-waiting-child'])
    const drained = providerEvent('claude', {
      hook_event_name: 'SubagentStop',
      agent_id: 'claude-waiting-child'
    })
    expect(drained?.payload.state).toBe('working')
    expect(
      providerEvent('claude', {
        hook_event_name: 'SubagentStop',
        agent_id: 'claude-unrelated-child'
      })?.payload.state
    ).toBe('done')
    expect(drained?.payload.interrupted).toBeUndefined()
  })

  it('rejects overlong and over-cap Claude wait owners without pinning attention', () => {
    providerEvent('claude', { hook_event_name: 'Stop' })
    const overlong = providerEvent('claude', {
      hook_event_name: 'PermissionRequest',
      agent_id: 'x'.repeat(65)
    })
    expect(overlong?.payload.state).toBe('done')
    expect(overlong?.payload.subagents).toBeUndefined()

    const childIds = Array.from(
      { length: AGENT_STATUS_MAX_SUBAGENTS },
      (_, index) => `claude-child-${String(index).padStart(2, '0')}`
    )
    for (const agentId of childIds) {
      providerEvent('claude', { hook_event_name: 'SubagentStart', agent_id: agentId })
    }
    const overflow = providerEvent('claude', {
      hook_event_name: 'PermissionRequest',
      agent_id: 'claude-overflow-child'
    })
    expect(overflow?.payload.state).toBe('working')
    expect(overflow?.payload.waitingSubagentIds).toBeUndefined()
    expect(overflow?.payload.subagents).toHaveLength(AGENT_STATUS_MAX_SUBAGENTS)

    let last: ReturnType<typeof providerEvent> = null
    for (const agentId of childIds) {
      last = providerEvent('claude', { hook_event_name: 'SubagentStop', agent_id: agentId })
    }
    expect(last?.payload.state).toBe('done')
  })

  it('persists an interrupted Claude lead until the final hydrated child drains', () => {
    providerEvent('claude', {
      hook_event_name: 'SubagentStart',
      agent_id: 'claude-interrupted-child',
      agent_type: 'reviewer'
    })
    const interrupted = providerEvent('claude', {
      hook_event_name: 'Stop',
      is_interrupt: true
    })
    expect(interrupted?.payload).toMatchObject({
      state: 'working',
      leadState: 'done',
      leadInterrupted: true
    })
    expect(interrupted?.payload.interrupted).toBeUndefined()

    state = createHookListenerState()
    seedAgentSubagentLifecycleFromSnapshots(
      state,
      PANE_KEY,
      'claude',
      interrupted!.payload.subagents!,
      {
        leadState: interrupted!.payload.leadState,
        leadInterrupted: interrupted!.payload.leadInterrupted
      }
    )
    const drained = providerEvent('claude', {
      hook_event_name: 'SubagentStop',
      agent_id: 'claude-interrupted-child'
    })
    expect(drained?.payload.state).toBe('done')
    expect(drained?.payload.interrupted).toBe(true)
  })

  it('clears stale Claude child waits when an interrupt is inferred outside the hook stream', () => {
    providerEvent('claude', {
      hook_event_name: 'PermissionRequest',
      agent_id: 'claude-blocked-child',
      agent_type: 'reviewer'
    })
    markClaudeLeadTurnInterrupted(state, PANE_KEY)

    const childActivity = providerEvent('claude', {
      hook_event_name: 'PreToolUse',
      agent_id: 'claude-blocked-child',
      tool_name: 'Read'
    })
    expect(childActivity?.payload.state).toBe('working')

    const drained = providerEvent('claude', {
      hook_event_name: 'SubagentStop',
      agent_id: 'claude-blocked-child'
    })
    expect(drained?.payload).toMatchObject({ state: 'done', interrupted: true })
  })
})
