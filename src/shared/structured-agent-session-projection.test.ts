import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_MAX_FIELD_LENGTH } from './agent-status-field-normalization'
import type { AgentJournalRenderItem } from './agent-session-journal-types'
import { parsePaneKey } from './stable-pane-id'
import {
  activeStructuredAgentSessionTurnId,
  hasPersistedStructuredAgentSessionTurn,
  projectStructuredItemToNativeChat,
  projectStructuredAgentSessionStatus,
  projectStructuredAgentSessionStatusSummary,
  structuredAgentSessionPaneKey
} from './structured-agent-session-projection'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

describe('structured agent session status projection', () => {
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
})
