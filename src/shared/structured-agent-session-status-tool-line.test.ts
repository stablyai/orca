import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalToolCallState
} from './agent-session-journal-types'
import { describeToolInput } from './native-chat-tool-summary'
import {
  projectStructuredAgentSessionStatusSummary,
  projectStructuredItemsToNativeChat
} from './structured-agent-session-projection'
import { statusStructuredAgentSessionToolCall } from './structured-agent-session-live-turn'

function item(
  itemId: string,
  sequence: number,
  body: AgentJournalRenderItem['body']
): AgentJournalRenderItem {
  return { itemId, sequence, revision: 1, observedAt: sequence, body }
}

function child(base: AgentJournalRenderItem): AgentJournalRenderItem {
  return { ...base, agentId: 'task-1', producerKind: 'agent' }
}

function submission(clientMessageId: string): AgentJournalSubmission {
  return {
    clientMessageId,
    fence: 1,
    payloadFingerprint: clientMessageId,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

describe('tool line between tool calls', () => {
  const ask = item('ask', 1, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'go' }]
  })
  const running = item('running', 2, {
    kind: 'status',
    text: 'Working',
    turnLifecycle: { turnId: 'turn-1', state: 'running' }
  })
  const call = (id: string, sequence: number, name: string, state: AgentJournalToolCallState) =>
    item(id, sequence, {
      kind: 'tool-call',
      name,
      input: { file_path: `/repo/${name}.ts` },
      state
    })

  it('keeps naming the finished tool while the agent thinks', () => {
    const summary = projectStructuredAgentSessionStatusSummary([
      ask,
      running,
      call('read', 3, 'Read', 'completed')
    ])
    expect(summary).toMatchObject({ toolName: 'Read', toolInput: '/repo/Read.ts' })
  })

  // Codex marks any nonzero exit failed (a no-match search, a red test), so clearing would blank the line.
  it('keeps naming a failed call until the next tool starts', () => {
    const summary = projectStructuredAgentSessionStatusSummary([
      ask,
      running,
      call('read', 3, 'Read', 'completed'),
      call('edit', 4, 'Edit', 'failed')
    ])
    expect(summary).toMatchObject({ toolName: 'Edit', toolInput: '/repo/Edit.ts' })
  })

  it('prefers a running call over a newer finished one', () => {
    const summary = projectStructuredAgentSessionStatusSummary([
      ask,
      running,
      call('bash', 3, 'Bash', 'running'),
      call('read', 4, 'Read', 'completed')
    ])
    expect(summary.toolName).toBe('Bash')
  })

  it("never carries an earlier turn's finished tool into the live one", () => {
    const nextTurn = item('next-turn', 4, {
      kind: 'status',
      text: 'Working',
      turnLifecycle: { turnId: 'turn-2', state: 'running' }
    })
    const summary = projectStructuredAgentSessionStatusSummary([
      ask,
      running,
      call('read', 3, 'Read', 'completed'),
      nextTurn
    ])
    expect(summary.toolName).toBeUndefined()
  })

  // A send's user row lands at submit time, mid-turn too; the turn record bounds the turn.
  const followUp = item('follow-up', 5, {
    kind: 'message',
    role: 'user',
    blocks: [{ type: 'text', text: 'also check the tests' }]
  })

  it("keeps naming the running turn's tool past a mid-turn send", () => {
    const pending = [submission('follow-up')]
    expect(
      projectStructuredAgentSessionStatusSummary(
        [ask, running, call('bash', 3, 'Bash', 'running'), followUp],
        pending
      ).toolName
    ).toBe('Bash')
    expect(
      projectStructuredAgentSessionStatusSummary(
        [ask, running, call('read', 3, 'Read', 'completed'), followUp],
        pending
      ).toolName
    ).toBe('Read')
  })

  it('names nothing from an ended turn while the next send is pending', () => {
    // The record keeps its creation slot when revised to completed, so it sits before its calls.
    const ended = item('running', 2, {
      kind: 'status',
      text: 'Done',
      turnLifecycle: { turnId: 'turn-1', state: 'completed' }
    })
    const summary = projectStructuredAgentSessionStatusSummary(
      [ask, ended, call('read', 3, 'Read', 'completed'), followUp],
      [submission('follow-up')]
    )
    expect(summary.status).toBe('working')
    expect(summary.toolName).toBeUndefined()
  })

  const patch = { head: '@@\n+x', digest: 'd', byteLength: 5, truncated: false }

  describe('a Codex edit, which the chat draws as a Diff', () => {
    const command = (
      id: string,
      sequence: number,
      text: string,
      state: AgentJournalToolCallState
    ) => item(id, sequence, { kind: 'tool-call', name: 'shell', input: { command: text }, state })
    const diff = (id: string, sequence: number, path: string) =>
      item(id, sequence, { kind: 'diff', path, patch })
    const rg = command('rg', 3, 'rg foo', 'completed')

    it('names the edit, not the command before it', () => {
      const summary = projectStructuredAgentSessionStatusSummary([
        ask,
        running,
        rg,
        diff('edit', 4, 'src/a.ts')
      ])
      expect(summary).toMatchObject({ toolName: 'Diff', toolInput: 'src/a.ts' })
    })

    it('moves from the running apply_patch call to the Diff the same item becomes', () => {
      const applying = item('edit', 4, {
        kind: 'tool-call',
        name: 'apply_patch',
        input: { changes: [] },
        state: 'running'
      })
      const written = { ...diff('edit', 4, 'src/a.ts'), revision: 2 }
      expect(
        projectStructuredAgentSessionStatusSummary([ask, running, rg, applying]).toolName
      ).toBe('apply_patch')
      expect(projectStructuredAgentSessionStatusSummary([ask, running, rg, written])).toMatchObject(
        { toolName: 'Diff', toolInput: 'src/a.ts' }
      )
    })

    it('lets an older running command beat a newer Diff, which has no lifecycle', () => {
      const summary = projectStructuredAgentSessionStatusSummary([
        ask,
        running,
        command('test', 3, 'pnpm test', 'running'),
        diff('edit', 4, 'src/a.ts')
      ])
      expect(summary).toMatchObject({ toolName: 'shell', toolInput: 'pnpm test' })
    })

    it.each(['completed', 'failed'] as const)(
      'names a later %s command over an earlier Diff',
      (state) => {
        const summary = projectStructuredAgentSessionStatusSummary([
          ask,
          running,
          diff('edit', 3, 'src/a.ts'),
          command('test', 4, 'pnpm test', state)
        ])
        expect(summary).toMatchObject({ toolName: 'shell', toolInput: 'pnpm test' })
      }
    )

    it('names a multi-file edit by its file count, as the chat does', () => {
      const summary = projectStructuredAgentSessionStatusSummary([
        ask,
        running,
        rg,
        diff('edit', 4, '3 files')
      ])
      expect(summary).toMatchObject({ toolName: 'Diff', toolInput: '3 files' })
    })

    it("never names a subagent's Diff", () => {
      const childEdit = child(diff('child-edit', 4, 'src/child.ts'))
      expect(
        projectStructuredAgentSessionStatusSummary([ask, running, rg, childEdit]).toolName
      ).toBe('shell')
      expect(statusStructuredAgentSessionToolCall([ask, running, childEdit])).toBeNull()
    })

    it("names nothing from an ended turn's Diff", () => {
      const ended = item('running', 2, {
        kind: 'status',
        text: 'Done',
        turnLifecycle: { turnId: 'turn-1', state: 'completed' }
      })
      const items = [ask, ended, diff('edit', 3, 'src/a.ts'), followUp]
      expect(statusStructuredAgentSessionToolCall(items)).toBeNull()
      expect(
        projectStructuredAgentSessionStatusSummary(items, [submission('follow-up')]).toolName
      ).toBeUndefined()
    })
  })

  // The row names the chat's own block, so a tool the chat draws can never read differently here.
  it('names, at every point in a turn, the block the chat draws for that tool', () => {
    const timeline: AgentJournalRenderItem[] = [
      ask,
      running,
      item('rg', 3, {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'rg foo' },
        callId: 'rg',
        exitCode: 0,
        state: 'completed'
      }),
      child(item('child-edit', 4, { kind: 'diff', path: 'src/child.ts', patch })),
      item('edit', 5, { kind: 'diff', path: 'src/a.ts', patch }),
      item('think', 6, {
        kind: 'message',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'next' }]
      }),
      item('follow-up', 7, {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: 'also check the tests' }]
      }),
      item('test', 8, {
        kind: 'tool-call',
        name: 'shell',
        input: { command: 'pnpm test' },
        state: 'running'
      }),
      child(
        item('child-grep', 9, {
          kind: 'tool-call',
          name: 'Grep',
          input: { pattern: 'x' },
          state: 'running'
        })
      ),
      item('multi', 10, { kind: 'diff', path: '2 files', patch })
    ]
    for (let end = 2; end <= timeline.length; end += 1) {
      const items = timeline.slice(0, end)
      const chatCalls = projectStructuredItemsToNativeChat(
        items.slice(2).filter((entry) => entry.agentId === undefined)
      )
        .flatMap((message) => message.blocks)
        .filter((block) => block.type === 'tool-call')
      const expected =
        chatCalls.findLast((block) => block.state === 'running') ?? chatCalls.at(-1) ?? null
      expect(statusStructuredAgentSessionToolCall(items)).toEqual(expected)
      const summary = projectStructuredAgentSessionStatusSummary(items)
      expect(summary.toolName).toBe(expected?.name)
      expect(summary.toolInput).toBe(expected ? describeToolInput(expected.input) : undefined)
    }
  })
})
