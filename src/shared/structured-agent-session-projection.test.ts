import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-field-normalization'
import type { AgentJournalRenderItem, AgentJournalSubmission } from './agent-session-journal-types'
import { parsePaneKey } from './stable-pane-id'
import {
  activeStructuredAgentSessionTurnId,
  hasPersistedStructuredAgentSessionTurn,
  hasUnansweredStructuredAgentSessionDispatch,
  projectStructuredItemToNativeChat,
  projectStructuredItemsToNativeChat,
  latestStructuredAgentSessionAssistantMessage,
  projectStructuredAgentSessionStatus,
  projectStructuredAgentSessionStatusSummary,
  structuredAgentSessionPaneKey
} from './structured-agent-session-projection'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

function submission(
  clientMessageId: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 2
  }
}

describe('structured agent session status projection', () => {
  it('reuses immutable item projections and refreshes revisions and resolved prompts', () => {
    const original = item('diff', 1, {
      kind: 'diff',
      path: 'a.ts',
      patch: {
        head: '@@\n+first',
        digest: 'one',
        byteLength: 10,
        truncated: false
      }
    })
    const first = projectStructuredItemToNativeChat(original)
    expect(projectStructuredItemToNativeChat(original)).toBe(first)
    const revised = {
      ...original,
      revision: 2,
      observedAt: 2000,
      body: {
        kind: 'diff' as const,
        path: 'a.ts',
        patch: {
          head: '@@\n+second',
          digest: 'two',
          byteLength: 11,
          truncated: false
        }
      }
    }
    const second = projectStructuredItemToNativeChat(revised)
    expect(second).not.toBe(first)
    expect(second).toMatchObject({
      timestamp: 2000,
      blocks: [{ type: 'tool-call' }, { type: 'tool-result', output: '@@\n+second' }]
    })
    expect(second?.blocks).toEqual([
      { type: 'tool-call', name: 'Diff', input: { path: 'a.ts' } },
      { type: 'tool-result', output: '@@\n+second' }
    ])
    const pending = item('approval', 2, {
      kind: 'approval',
      title: 'Allow?',
      detail: null,
      options: [],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    expect(projectStructuredItemToNativeChat(pending)).toBeNull()
    if (pending.body.kind !== 'approval') {
      throw new Error('fixture')
    }
    const resolved = {
      ...pending,
      revision: 2,
      body: {
        ...pending.body,
        resolution: { ...pending.body.resolution, state: 'resolved' as const }
      }
    }
    expect(projectStructuredItemToNativeChat(resolved)).toMatchObject({
      id: 'approval',
      role: 'system'
    })
  })

  it('projects running, attention, and completed lifecycle states', () => {
    const running = item('running', 1, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    })
    const prompt = item('prompt', 2, {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    const completed = item('completed', 3, {
      kind: 'status',
      text: 'Done',
      turnLifecycle: { turnId: 'turn-1', state: 'completed' }
    })

    expect(activeStructuredAgentSessionTurnId([running])).toBe('turn-1')
    expect(projectStructuredAgentSessionStatus([running])).toBe('working')
    expect(projectStructuredAgentSessionStatus([running, prompt])).toBe('attention')
    expect(activeStructuredAgentSessionTurnId([running, completed])).toBeNull()
    expect(projectStructuredAgentSessionStatus([running, completed])).toBe('idle')
  })

  it('summarizes status with the newest user prompt, and null before any persisted turn', () => {
    const running = item('running', 3, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    })
    const first = item('first', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'first' }]
    })
    const second = item('second', 2, {
      kind: 'message',
      role: 'user',
      blocks: [
        { type: 'text', text: 'second' },
        { type: 'text', text: 'line' }
      ]
    })

    expect(projectStructuredAgentSessionStatusSummary([running])).toEqual({
      status: null,
      latestPrompt: ''
    })
    expect(projectStructuredAgentSessionStatusSummary([first, second, running])).toEqual({
      status: 'working',
      latestPrompt: 'second line'
    })
    expect(projectStructuredAgentSessionStatusSummary([first, second])).toEqual({
      status: 'idle',
      latestPrompt: 'second line'
    })
  })

  it('reads a session as working while a dispatch is unanswered, before any lifecycle row', () => {
    const asked = item('asked', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const pending = [submission('m1', 'pending')]

    expect(hasUnansweredStructuredAgentSessionDispatch(pending)).toBe(true)
    expect(projectStructuredAgentSessionStatus([asked], pending)).toBe('working')
    // The first send has no journalled message until the provider replays it.
    expect(projectStructuredAgentSessionStatusSummary([], pending)).toEqual({
      status: 'working',
      latestPrompt: ''
    })
    expect(projectStructuredAgentSessionStatusSummary([asked], pending)).toEqual({
      status: 'working',
      latestPrompt: 'go'
    })
  })

  it('does not resurrect old-host unknown work after its execution fence advances', () => {
    const oldHostSubmission = { ...submission('m1', 'unknown'), fence: 2 }
    expect(hasUnansweredStructuredAgentSessionDispatch([oldHostSubmission], 2)).toBe(true)
    expect(hasUnansweredStructuredAgentSessionDispatch([oldHostSubmission], 3)).toBe(false)
  })

  it('recognizes recovery from an older host without the optional marker', () => {
    expect(
      hasUnansweredStructuredAgentSessionDispatch([
        { ...submission('m1', 'unknown'), reason: 'host_restarted_before_acknowledgement' }
      ])
    ).toBe(false)
  })

  it('stops reading a resolved dispatch as work, and lets a pending prompt outrank it', () => {
    const asked = item('asked', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const prompt = item('prompt', 2, {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })

    for (const state of ['accepted', 'rejected'] as const) {
      expect(hasUnansweredStructuredAgentSessionDispatch([submission('m1', state)])).toBe(false)
      expect(projectStructuredAgentSessionStatus([asked], [submission('m1', state)])).toBe('idle')
    }
    // The ack budget elapsing is a delivery answer, not an answer about the turn.
    expect(hasUnansweredStructuredAgentSessionDispatch([submission('m1', 'unknown')])).toBe(true)
    expect(
      hasUnansweredStructuredAgentSessionDispatch([
        { ...submission('m1', 'unknown'), recovered: true }
      ])
    ).toBe(false)
    expect(
      projectStructuredAgentSessionStatus([asked, prompt], [submission('m1', 'pending')])
    ).toBe('attention')
    expect(projectStructuredAgentSessionStatusSummary([], [])).toEqual({
      status: null,
      latestPrompt: ''
    })
  })

  it('carries the running tool and the newest assistant prose the sidebar row shows', () => {
    const ask = item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'look at the sidebar' }]
    })
    const running = item('running', 2, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-1', state: 'running' }
    })
    const said = item('said', 3, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Reading the card first.' }]
    })
    const tool = item('tool', 4, {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: '/repo/src/WorktreeCard.tsx' },
      state: 'running'
    })

    expect(projectStructuredAgentSessionStatusSummary([ask, running, said, tool])).toEqual({
      status: 'working',
      latestPrompt: 'look at the sidebar',
      toolName: 'Read',
      toolInput: '/repo/src/WorktreeCard.tsx',
      lastAssistantMessage: 'Reading the card first.'
    })
  })

  it('clears the previous answer as soon as the next prompt is persisted', () => {
    const firstAsk = item('first-ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'first task' }]
    })
    const previousAnswer = item('previous-answer', 2, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The first task is done.' }]
    })
    const nextAsk = item('next-ask', 3, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'second task' }]
    })
    expect(projectStructuredAgentSessionStatusSummary([firstAsk, previousAnswer, nextAsk])).toEqual(
      {
        status: 'idle',
        latestPrompt: 'second task'
      }
    )
  })

  it('reports no tool line once the turn settles, even with an abandoned running call', () => {
    const ask = item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const abandoned = item('abandoned', 2, {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'sleep 600' },
      state: 'running'
    })

    expect(projectStructuredAgentSessionStatusSummary([ask, abandoned])).toEqual({
      status: 'idle',
      latestPrompt: 'go'
    })
  })

  it('never adopts a running call from a turn older than the live one', () => {
    const ask = item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const abandoned = item('abandoned', 2, {
      kind: 'tool-call',
      name: 'Bash',
      input: { command: 'sleep 600' },
      state: 'running'
    })
    const running = item('running', 3, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-2', state: 'running' }
    })

    expect(projectStructuredAgentSessionStatusSummary([ask, abandoned, running])).toEqual({
      status: 'working',
      latestPrompt: 'go'
    })
  })

  it('skips a tool-only assistant item to reach the newest prose', () => {
    const ask = item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const said = item('said', 2, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Done — the card now aligns.' }]
    })
    const wordless = item('wordless', 3, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'Read', input: {} }]
    })

    expect(
      projectStructuredAgentSessionStatusSummary([ask, said, wordless]).lastAssistantMessage
    ).toBe('Done — the card now aligns.')
  })

  it('bounds the assistant preview at the shared agent-status preview cap', () => {
    const ask = item('ask', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const rambled = item('rambled', 2, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'y'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH * 40) }]
    })

    expect(
      projectStructuredAgentSessionStatusSummary([ask, rambled]).lastAssistantMessage
    ).toHaveLength(AGENT_STATUS_MAX_FIELD_LENGTH)
  })

  it('bounds the wire prompt at the shared agent-status preview cap', () => {
    const pasted = item('pasted', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'x'.repeat(AGENT_STATUS_MAX_FIELD_LENGTH * 40) }]
    })

    expect(projectStructuredAgentSessionStatusSummary([pasted]).latestPrompt).toHaveLength(
      AGENT_STATUS_MAX_FIELD_LENGTH
    )
  })

  it('creates a deterministic pane identity for status stores', () => {
    const paneKey = structuredAgentSessionPaneKey('structured-agent-session-1', 'session-1')

    expect(structuredAgentSessionPaneKey('structured-agent-session-1', 'session-1')).toBe(paneKey)
    expect(parsePaneKey(paneKey)).toMatchObject({ tabId: 'structured-agent-session-1' })
  })

  it('requires a persisted provider conversation turn before TUI resume', () => {
    const status = item('status', 1, { kind: 'status', text: 'Connected' })
    const user = item('user', 2, { kind: 'message', role: 'user', blocks: [] })

    expect(hasPersistedStructuredAgentSessionTurn([])).toBe(false)
    expect(hasPersistedStructuredAgentSessionTurn([status])).toBe(false)
    expect(hasPersistedStructuredAgentSessionTurn([status, user])).toBe(true)
  })

  it('preserves provider-frame detail on the backward-compatible status line', () => {
    const projected = projectStructuredItemToNativeChat(
      item('frame', 1, {
        kind: 'status',
        text: 'codex · notification:new/event',
        providerFrame: {
          provider: 'codex',
          kind: 'notification:new/event',
          payload: { head: '{}', byteLength: 2, digest: 'digest', truncated: false }
        }
      })
    )

    expect(projected?.blocks).toEqual([
      expect.objectContaining({
        type: 'text',
        text: 'codex · notification:new/event',
        providerFrame: expect.objectContaining({ kind: 'notification:new/event' })
      })
    ])
  })

  it('preserves structured tool lifecycle state for the live renderer', () => {
    const projected = projectStructuredItemToNativeChat(
      item('running-tool', 1, {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'cat package.json' },
        state: 'running'
      })
    )

    expect(projected?.blocks).toEqual([
      { type: 'tool-call', name: 'shell', input: { command: 'cat package.json' }, state: 'running' }
    ])
  })

  it('projects a turn record to no message', () => {
    const turn = item('turn', 1, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      startedAt: 1_000,
      completedAt: 4_000
    })

    expect(projectStructuredItemToNativeChat(turn)).toBeNull()
  })

  it('projects an item kind this build does not know to no message, never a text bubble', () => {
    const unknown = item('future', 1, {
      kind: 'future-kind',
      text: 'a newer host wrote this'
    } as unknown as AgentJournalRenderItem['body'])

    expect(projectStructuredItemToNativeChat(unknown)).toBeNull()
  })
})

describe('notice projection for desktop and mobile consumers', () => {
  it.each([
    { presentation: 'compaction' },
    { presentation: 'plan-document' },
    { tone: 'warning' },
    { tone: 'error' },
    { tone: 'notice' },
    { presentation: 'future-presentation', tone: 'future-tone' }
  ])('preserves readable text alongside optional metadata: %j', (metadata) => {
    const projected = projectStructuredItemToNativeChat(
      item('notice', 1, {
        kind: 'status',
        text: 'A readable document or notice',
        ...metadata
      })
    )
    expect(projected).toMatchObject({
      role: 'system',
      blocks: [{ type: 'text', text: 'A readable document or notice', ...metadata }]
    })
  })
})

it('preserves optional tool annotations for desktop and mobile projection', () => {
  const metadata = {
    callId: 'call-1',
    exitCode: 127,
    durationMs: 400,
    webSearchResults: [{ title: 'Docs', url: 'https://example.com' }]
  }
  const projected = projectStructuredItemToNativeChat(
    item('annotated', 1, {
      kind: 'tool-call',
      name: 'shell',
      input: null,
      state: 'failed',
      ...metadata
    })
  )
  expect(projected?.blocks[0]).toEqual({
    type: 'tool-call',
    name: 'shell',
    input: null,
    state: 'failed',
    ...metadata
  })
})

it('preserves confirmed MCP identity and the raw name through projection', () => {
  const body = {
    kind: 'tool-call' as const,
    name: 'my_server/ns.tool',
    input: null,
    state: 'running' as const,
    mcpIdentity: { server: 'my_server', tool: 'ns.tool' }
  }
  const projected = projectStructuredItemToNativeChat(item('mcp', 1, body))
  expect(projected?.blocks[0]).toMatchObject({
    name: body.name,
    mcpIdentity: body.mcpIdentity,
    type: 'tool-call'
  })
})

describe("producer linkage — a subagent's output never speaks for the parent", () => {
  /** A row a subagent produced. Same journal, same session; only linkage differs. */
  function childItem(
    itemId: string,
    sequence: number,
    body: AgentJournalRenderItem['body'],
    agentId = 'task-1'
  ): AgentJournalRenderItem {
    return { ...item(itemId, sequence, body), agentId, producerKind: 'agent' }
  }

  const userAsk = item('user-1', 1, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'summarise the repo' }]
  })
  const turnRunning = item('turn-1', 2, { kind: 'turn', turnId: 'turn-1', state: 'running' })
  const parentProse = item('root-prose', 3, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'delegating' }]
  })
  const spawnCall = item('root-task', 4, {
    kind: 'tool-call',
    name: 'Task',
    input: { description: 'explore the lane' },
    state: 'running'
  })
  const childProse = childItem('child-prose', 5, {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'looking' }]
  })
  const childCall = childItem('child-grep', 6, {
    kind: 'tool-call',
    name: 'Grep',
    input: { pattern: 'x' },
    state: 'running'
  })
  const items = [userAsk, turnRunning, parentProse, spawnCall, childProse, childCall]

  it("shows the parent's own prose and its own running call, not the child's newer ones", () => {
    expect(latestStructuredAgentSessionAssistantMessage(items)).toBe('delegating')
    expect(statusStructuredAgentSessionToolCall(items)?.name).toBe('Task')
  })

  it("publishes the parent's own line and call on the summary the sidebar reads", () => {
    const summary = projectStructuredAgentSessionStatusSummary(items)
    expect(summary.status).toBe('working')
    expect(summary.lastAssistantMessage).toBe('delegating')
    expect(summary.toolName).toBe('Task')
    // The row does not go blank while a child runs: the spawn call is still the
    // parent's own live work.
    expect(summary.toolInput).toBeTruthy()
  })

  it("names the parent's own settled call, not a child's newer settled one", () => {
    const parentRead = item('root-read', 4, {
      kind: 'tool-call',
      name: 'Read',
      input: { file_path: '/repo/a.ts' },
      state: 'completed'
    })
    const childFailed = childItem('child-grep', 6, {
      kind: 'tool-call',
      name: 'Grep',
      input: { pattern: 'x' },
      state: 'failed'
    })
    expect(
      projectStructuredAgentSessionStatusSummary([userAsk, turnRunning, parentRead, childFailed])
        .toolName
    ).toBe('Read')
  })

  it("still renders the child's output in the transcript", () => {
    // The other direction: scoping the STATUS readers must not delete subagent
    // output from the chat.
    const prose = projectStructuredItemsToNativeChat(items).flatMap((message) =>
      message.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : []))
    )
    expect(prose).toContain('looking')
    expect(prose).toContain('delegating')
  })

  it("falls back to nothing rather than a child's line when the parent said nothing", () => {
    const summary = projectStructuredAgentSessionStatusSummary([
      userAsk,
      turnRunning,
      spawnCall,
      childProse,
      childCall
    ])
    expect(summary.lastAssistantMessage).toBeUndefined()
    expect(summary.toolName).toBe('Task')
  })

  it('attributes rows without reading their neighbours', () => {
    // A window holding only the child's own rows: no spawn call, no turn record.
    // Nothing here is re-derived from a start row, so attribution does not
    // depend on how much of the timeline a reader happens to hold. (This store
    // has no compaction and paginates complete-or-reset, so such a window is not
    // reachable today — the point is that the rule does not rely on that.)
    const windowed = [childProse, childCall]
    expect(latestStructuredAgentSessionAssistantMessage(windowed)).toBe('')
    expect(statusStructuredAgentSessionToolCall(windowed)).toBeNull()
  })

  it("does not quote a subagent's own user-role prompt as the session's", () => {
    const childPrompt = childItem('child-prompt', 5, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'explore the lane' }]
    })
    expect(
      projectStructuredAgentSessionStatusSummary([userAsk, turnRunning, spawnCall, childPrompt])
        .latestPrompt
    ).toBe('summarise the repo')
  })

  it('keeps a nested child off the parent, read through the projection', () => {
    // A grandchild: its own agent id, and a parent that is not the session root.
    const grandchild: AgentJournalRenderItem = {
      ...item('grandchild-prose', 7, {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: 'deeper' }]
      }),
      agentId: 'task-2',
      parentAgentId: 'task-1',
      producerKind: 'agent'
    }
    const nested = [...items, grandchild]
    expect(latestStructuredAgentSessionAssistantMessage(nested)).toBe('delegating')
    // Naming a parent does not make the row that parent's: the summary the
    // sidebar reads still shows the session's own line.
    expect(projectStructuredAgentSessionStatusSummary(nested).lastAssistantMessage).toBe(
      'delegating'
    )
    // And the transcript still renders it, so naming a parent is not a filter.
    expect(
      projectStructuredItemsToNativeChat(nested).some((block) =>
        JSON.stringify(block).includes('deeper')
      )
    ).toBe(true)
  })

  it('treats an agent id that failed to resolve as a child rather than as the parent', () => {
    const unresolved = childItem(
      'child-unresolved',
      5,
      { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'looking' }] },
      ''
    )
    expect(
      latestStructuredAgentSessionAssistantMessage([userAsk, turnRunning, parentProse, unresolved])
    ).toBe('delegating')
  })

  it("reads a row written before linkage existed as the parent's own", () => {
    // A journal open across the upgrade has unmarked child rows below marked
    // ones. Absence means root, which reproduces exactly what those journals
    // always showed — it is never "unknown".
    const legacyChildProse = item('legacy-child', 5, {
      kind: 'message',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'legacy child line' }]
    })
    expect(
      latestStructuredAgentSessionAssistantMessage([
        userAsk,
        turnRunning,
        parentProse,
        spawnCall,
        legacyChildProse,
        childProse
      ])
    ).toBe('legacy child line')
  })
})

describe('the turn verdict on the status summary', () => {
  const user = item('u1', 1, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'go' }]
  })

  it('carries the newest settled turn verdict only while the session is idle', () => {
    const running = item('turn-running', 2, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'running'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, running])).not.toHaveProperty(
      'turnOutcome'
    )
    const cancelled = item('turn-cancelled', 3, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, cancelled])).toMatchObject({
      status: 'idle',
      turnOutcome: 'cancellation'
    })
  })

  it('reports no verdict for a settled turn the provider never judged', () => {
    const completed = item('turn-completed', 2, {
      kind: 'turn',
      turnId: 'turn-1',
      state: 'completed'
    })
    expect(projectStructuredAgentSessionStatusSummary([user, completed])).not.toHaveProperty(
      'turnOutcome'
    )
  })
})
