import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from '../../agent-status/contracts/agent-status-field-normalization'
import { agentSessionFailureWords } from '../failures/agent-session-failure-words'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { AgentJournalRenderItemSchema } from '../journal/agent-session-journal-schemas'
import './structured-agent-session-live-turn'
import {
  projectStructuredItemToNativeChat,
  projectStructuredItemsToNativeChat,
  projectStructuredAgentSessionStatus,
  projectStructuredAgentSessionStatusState,
  projectStructuredAgentSessionStatusSummary
} from './structured-agent-session-projection'
import { hasUnansweredStructuredAgentSessionDispatch } from '../requests/structured-agent-session-unanswered-dispatch'
import { latestStructuredAgentSessionAssistantMessage } from '../requests/structured-agent-session-latest-request'

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
      { type: 'tool-call', name: 'Diff', input: { path: 'a.ts' }, callId: 'diff' },
      { type: 'tool-result', output: '@@\n+second', callId: 'diff' }
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

  it("forwards a status row's failure fact and drops one this build cannot place", () => {
    const words = agentSessionFailureWords(
      {
        kind: 'providerExited',
        detail: { text: 'stderr tail', audience: 'log' }
      },
      { surface: 'row' }
    )
    expect(
      projectStructuredItemToNativeChat(item('exit', 1, { kind: 'status', ...words }))?.blocks[0]
    ).toEqual({ type: 'text', ...words })
    const future = item('future', 2, { kind: 'status', text: 'Stopped.' })
    // A newer host's kind reads as no fact, so the row keeps its text and nothing else.
    Object.assign(future.body, { failure: { kind: 'futureKind' } })
    expect(projectStructuredItemToNativeChat(future)?.blocks[0]).toEqual({
      type: 'text',
      text: 'Stopped.'
    })
  })

  it('carries a cut-short call through the schema, and its partial output is not an error', () => {
    const body = {
      kind: 'tool-call' as const,
      name: 'shell',
      callId: 'call-sleep',
      input: { command: 'sleep 20' },
      state: 'failed' as const,
      endedAs: 'interrupted' as const,
      output: { head: 'partial', digest: 'd', byteLength: 7, truncated: false }
    }
    const parsed = AgentJournalRenderItemSchema.parse(item('sleep', 1, body))
    expect(parsed.body).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
    expect(projectStructuredItemToNativeChat(item('sleep', 1, body))?.blocks).toEqual([
      expect.objectContaining({ type: 'tool-call', state: 'failed', endedAs: 'interrupted' }),
      { type: 'tool-result', output: 'partial', isError: false, callId: 'call-sleep' }
    ])
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

  it('still reports owed work beneath a pending prompt, which the attention status hides', () => {
    const asked = item('asked', 1, {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'go' }]
    })
    const prompt = item('prompt', 3, {
      kind: 'approval',
      title: 'Run command?',
      detail: null,
      options: [{ id: 'yes', label: 'Allow' }],
      resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
    })
    const running = item('turn', 2, { kind: 'turn', turnId: 't1', state: 'running' })
    const settled = item('turn', 2, {
      kind: 'turn',
      turnId: 't1',
      state: 'completed',
      outcome: 'success'
    })
    const accepted = [submission('m1', 'accepted')]
    const owes = (items: AgentJournalRenderItem[], submissions = accepted) => {
      const state = projectStructuredAgentSessionStatusState(items, submissions)
      return [state.summary.status, state.owesWork]
    }

    expect(owes([asked, running, prompt])).toEqual(['attention', true])
    expect(owes([asked, settled, prompt])).toEqual(['attention', false])
    expect(owes([asked, settled, prompt], [...accepted, submission('m2', 'pending')])).toEqual([
      'attention',
      true
    ])
    expect(owes([asked, running])).toEqual(['working', true])
    expect(owes([asked, settled])).toEqual(['idle', false])
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
      latestPrompt: 'go',
      statusStartedAt: 3
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

  it('projects an item kind this build does not know to no message, never a text bubble', () => {
    const unknown = item('future', 1, {
      kind: 'future-kind',
      text: 'a newer host wrote this'
    } as unknown as AgentJournalRenderItem['body'])

    expect(projectStructuredItemToNativeChat(unknown)).toBeNull()
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

  it("publishes the parent's own line and call on the summary the sidebar reads", () => {
    const summary = projectStructuredAgentSessionStatusSummary(items)
    expect(summary.status).toBe('working')
    expect(summary.lastAssistantMessage).toBe('delegating')
    expect(summary.toolName).toBe('Task')
    // Keep the parent’s spawn-call preview while its child runs.
    expect(summary.toolInput).toBeTruthy()
  })

  it("keeps the child's output as the child's: the transcript message names its producer", () => {
    // Keep producer identity or child output would appear to be the parent speaking.
    const messages = projectStructuredItemsToNativeChat(items)
    const byId = new Map(messages.map((message) => [message.id, message]))
    expect(byId.get('child-prose')).toMatchObject({ agentId: 'task-1', producerKind: 'agent' })
    expect(byId.get('child-grep')).toMatchObject({ agentId: 'task-1' })
    // The session's own rows name no producer: absence is the claim that they are its own.
    expect(byId.get('root-prose')).not.toHaveProperty('agentId')
    expect(byId.get('root-task')).not.toHaveProperty('agentId')
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
    // Legacy unmarked child rows retain historical root attribution across upgrades; absence is never unknown.
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
