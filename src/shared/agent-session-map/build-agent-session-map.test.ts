import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../agent-session/journal/agent-session-journal-types'
import { buildAgentSessionMap } from './build-agent-session-map'
import { mapStateAt } from './agent-session-map-playhead'

let sequence = 0
function item(
  body: AgentJournalRenderItem['body'],
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId: `item-${sequence}`,
    revision: 1,
    sequence,
    observedAt: 1000 * sequence,
    body,
    ...overrides
  }
}

function toolCall(
  name: string,
  state: 'running' | 'completed' | 'failed',
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return item({ kind: 'tool-call', name, input: { command: `run ${name}` }, state }, overrides)
}

function userPrompt(text: string): AgentJournalRenderItem {
  return item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text }] })
}

function spawnRoster(
  agents: [string, string, 'working' | 'completed' | 'failed'][],
  overrides: Partial<AgentJournalRenderItem> = {}
): AgentJournalRenderItem {
  return item(
    {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: `group-${sequence + 1}`,
          agents: agents.map(([id, label, state]) => ({ id, label, state }))
        }
      ]
    },
    overrides
  )
}

describe('buildAgentSessionMap', () => {
  // Stamp sequence/observedAt in array order so the timeline follows the story, not the
  // order the fixtures happened to be constructed in.
  function stamp(raw: AgentJournalRenderItem[]): AgentJournalRenderItem[] {
    return raw.map((entry, i) => ({ ...entry, sequence: i + 1, observedAt: 1000 * (i + 1) }))
  }

  it('builds root, subagents and edges from an interleaved journal', () => {
    const bashStart = toolCall('Bash', 'running')
    const bashDone = toolCall('Bash', 'completed', {
      itemId: bashStart.itemId,
      revision: 2
    })
    const readStart = toolCall('Read', 'running', { agentId: 'a1' })
    const readDone = toolCall('Read', 'completed', {
      itemId: readStart.itemId,
      revision: 2,
      agentId: 'a1'
    })
    const journal = stamp([
      userPrompt('fix the bug'),
      bashStart,
      spawnRoster([['a1', 'Explore the repo', 'working']]),
      readStart,
      readDone,
      bashDone,
      item({
        kind: 'turn',
        turnId: 't1',
        state: 'completed',
        durationMs: 4200
      })
    ])
    const map = buildAgentSessionMap(journal)
    expect(map.rootId).toBe('root')
    expect(map.nodes.map((node) => node.id)).toEqual(['root', 'a1'])
    expect(map.nodes[1]).toMatchObject({
      kind: 'subagent',
      label: 'Explore the repo',
      parentAgentId: 'root',
      subagentSettlement: { state: 'working' }
    })
    expect(map.edges).toEqual([{ from: 'root', to: 'a1', spawnedAt: journal[2].observedAt }])
    const root = map.nodes[0]
    expect(root.toolCalls.map((call) => call.name)).toEqual(['Bash'])
    expect(root.toolCalls[0]).toMatchObject({ state: 'completed', summary: 'run Bash' })
    expect(root.promptCount).toBe(1)
    expect(root.turns).toEqual([
      expect.objectContaining({ turnId: 't1', state: 'completed', durationMs: 4200 })
    ])
    expect(map.timeline.map((event) => event.kind)).toEqual([
      'prompt',
      'tool-start',
      'agent-spawn',
      'tool-start',
      'tool-end',
      'tool-end',
      'turn-end'
    ])
  })

  it('keeps the latest tool-call revision and latches the end once', () => {
    const start = toolCall('Bash', 'running')
    const done = toolCall('Bash', 'completed', {
      itemId: start.itemId,
      revision: 2,
      sequence: start.sequence + 1,
      body: {
        kind: 'tool-call',
        name: 'Bash',
        input: { command: 'run Bash' },
        state: 'completed',
        durationMs: 120
      }
    })
    const map = buildAgentSessionMap([start, done])
    const call = map.nodes[0].toolCalls[0]
    expect(call).toMatchObject({ state: 'completed', durationMs: 120 })
    expect(call.endTs).toBe(done.observedAt)
    const ends = map.timeline.filter((event) => event.kind === 'tool-end')
    expect(ends).toHaveLength(1)
  })

  it('settles a tool call whose first sighting is already terminal (crash recovery)', () => {
    const map = buildAgentSessionMap([toolCall('Grep', 'failed')])
    const call = map.nodes[0].toolCalls[0]
    expect(call).toMatchObject({ state: 'failed', endTs: call.startTs })
    expect(map.timeline.map((event) => event.kind)).toEqual(['tool-start', 'tool-end'])
    expect(map.timeline[1].failed).toBe(true)
  })

  it('treats an interrupted ending as unsuccessful, not failed-state', () => {
    const map = buildAgentSessionMap([
      toolCall('Bash', 'failed', {
        body: {
          kind: 'tool-call',
          name: 'Bash',
          input: {},
          state: 'failed',
          endedAs: 'interrupted'
        }
      })
    ])
    expect(map.timeline.at(-1)?.failed).toBe(true)
  })

  it('builds an empty journal as a lone unknown root with no events', () => {
    const map = buildAgentSessionMap([])
    expect(map.nodes).toHaveLength(1)
    expect(map.nodes[0].id).toBe('root')
    expect(map.timeline).toEqual([])
    expect(map.edges).toEqual([])
    const live = mapStateAt(map, null)
    expect(live.nodes[0].status).toBe('unknown')
  })

  it('places a subagent row that precedes any root row', () => {
    const journal = [
      toolCall('Read', 'running', { agentId: 'a1', parentAgentId: 'root' }),
      userPrompt('go')
    ]
    const map = buildAgentSessionMap(journal)
    expect(map.nodes.map((node) => node.id)).toEqual(['root', 'a1'])
    expect(map.nodes[1]).toMatchObject({ parentAgentId: 'root', label: 'a1' })
  })

  it('skips unknown item kinds without throwing', () => {
    const journal = [
      userPrompt('go'),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: simulates a body kind a newer build would emit, which the local union does not admit.
      item({ kind: 'brand-new-kind' as never, text: 'future' } as AgentJournalRenderItem['body'])
    ]
    const map = buildAgentSessionMap(journal)
    expect(map.nodes[0].promptCount).toBe(1)
  })

  it('tracks a pending question as waiting and clears it on resolution', () => {
    const pending = {
      state: 'pending' as const,
      selectedOptionId: null,
      resolvedBy: null,
      resolvedAt: null
    }
    const question = item({
      kind: 'question',
      question: 'Which approach?',
      options: [],
      resolution: pending
    })
    const resolved = item(
      {
        kind: 'question',
        question: 'Which approach?',
        options: [],
        resolution: {
          state: 'resolved',
          selectedOptionId: 'opt-1',
          resolvedBy: 'test',
          resolvedAt: question.observedAt + 500
        }
      },
      { itemId: question.itemId, revision: 2, sequence: question.sequence + 1 }
    )
    const map = buildAgentSessionMap([question, resolved])
    const atQuestion = mapStateAt(map, question.observedAt)
    expect(atQuestion.nodes[0].status).toBe('waiting')
    expect(atQuestion.nodes[0].waitingOn).toBe('question')
    const atResolved = mapStateAt(map, resolved.observedAt)
    expect(atResolved.nodes[0].status).not.toBe('waiting')
  })

  it('records diff paths once per node in first-seen order', () => {
    const patch = { head: '@@ -1 +1 @@', byteLength: 42, digest: 'ab'.repeat(32), truncated: false }
    const map = buildAgentSessionMap(
      stamp([
        item({ kind: 'diff', path: 'src/b.ts', patch }),
        item({ kind: 'diff', path: 'src/a.ts', patch }),
        item({ kind: 'diff', path: 'src/b.ts', patch }),
        item({ kind: 'diff', path: 'src/a.ts', patch }, { agentId: 'a1' })
      ])
    )
    expect(map.nodes[0].filesTouched).toEqual(['src/b.ts', 'src/a.ts'])
    expect(map.nodes[1].filesTouched).toEqual(['src/a.ts'])
  })

  it('keeps the newest user prompt text and its timestamp', () => {
    const map = buildAgentSessionMap(
      stamp([
        userPrompt('first prompt'),
        item({ kind: 'message', role: 'user', blocks: [{ type: 'text', text: '  ' }] }),
        userPrompt('second prompt')
      ])
    )
    const root = map.nodes[0]
    expect(root.promptCount).toBe(3)
    expect(root.lastPromptText).toBe('second prompt')
    expect(root.lastPromptTs).toBe(3000)
  })

  it('records the question text as request detail', () => {
    const map = buildAgentSessionMap([
      item({
        kind: 'question',
        question: 'Which approach?',
        options: [],
        resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
      })
    ])
    expect(map.nodes[0].requests[0]).toMatchObject({
      kind: 'question',
      detail: 'Which approach?'
    })
  })

  it('backdates a terminal-first-seen tool call from the provider duration', () => {
    // The journal reader keeps one row per itemId, so a call whose running row was
    // evicted is first seen already terminal; its start must come from durationMs.
    const map = buildAgentSessionMap([
      toolCall('Bash', 'completed', {
        observedAt: 100_000,
        body: {
          kind: 'tool-call',
          name: 'Bash',
          input: { command: 'pnpm test' },
          state: 'completed',
          durationMs: 5_000
        }
      })
    ])
    const call = map.nodes[0].toolCalls[0]
    expect(call).toMatchObject({
      state: 'completed',
      startTs: 95_000,
      endTs: 100_000,
      durationMs: 5_000
    })
    expect(map.timeline.map((event) => [event.kind, event.ts])).toEqual([
      ['tool-start', 95_000],
      ['tool-end', 100_000]
    ])
    // Scrubbing inside the backdated window shows the call still running.
    expect(mapStateAt(map, 97_000).nodes[0].status).toBe('running')
    expect(mapStateAt(map, 97_000).nodes[0].completedToolCount).toBe(0)
  })

  it('inherits the session span for a root with no rows of its own', () => {
    const map = buildAgentSessionMap([
      toolCall('Read', 'running', { agentId: 'a1', parentAgentId: 'root', observedAt: 5_000 })
    ])
    const root = map.nodes.find((node) => node.id === 'root')
    expect(root?.firstTs).toBe(5_000)
    expect(root?.lastTs).toBe(5_000)
  })

  it('keeps two requests that share a timestamp but differ by itemId', () => {
    const map = buildAgentSessionMap([
      item(
        {
          kind: 'approval',
          title: 'Run the migration',
          detail: null,
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { itemId: 'req-1', observedAt: 9_000 }
      ),
      item(
        {
          kind: 'approval',
          title: 'Push the branch',
          detail: null,
          options: [],
          resolution: {
            state: 'pending',
            selectedOptionId: null,
            resolvedBy: null,
            resolvedAt: null
          }
        },
        { itemId: 'req-2', observedAt: 9_000 }
      )
    ])
    expect(map.nodes[0].requests.map((request) => request.itemId)).toEqual(['req-1', 'req-2'])
  })

  it('does not mark a subagent done from events after the scrubbed moment', () => {
    const start = toolCall('Read', 'running', {
      agentId: 'a1',
      parentAgentId: 'root',
      observedAt: 1_000
    })
    const done = toolCall('Read', 'completed', {
      itemId: start.itemId,
      revision: 2,
      agentId: 'a1',
      parentAgentId: 'root',
      observedAt: 2_000
    })
    const nextPrompt = item(
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'next' }] },
      { observedAt: 5_000 }
    )
    const map = buildAgentSessionMap([start, done, nextPrompt])
    const statusAt = (ts: number | null) =>
      mapStateAt(map, ts).nodes.find((node) => node.nodeId === 'a1')?.status
    // At 3000 the root's later prompt is still the future: a1 is idle, not done.
    expect(statusAt(3_000)).toBe('idle')
    expect(statusAt(null)).toBe('done')
  })

  it('hides a status row written after the scrubbed moment', () => {
    const map = buildAgentSessionMap([
      item({ kind: 'status', text: 'working' }, { observedAt: 1_000 }),
      item({ kind: 'status', text: 'finished' }, { observedAt: 4_000 })
    ])
    // The fold retains only the latest status text; before its moment it is the
    // future and must be hidden, not shown.
    expect(mapStateAt(map, 2_000).nodes[0].lastStatusText).toBeUndefined()
    expect(mapStateAt(map, 4_000).nodes[0].lastStatusText).toBe('finished')
    expect(mapStateAt(map, null).nodes[0].lastStatusText).toBe('finished')
  })

  it('summarizes tool inputs per tool and survives odd inputs', () => {
    const map = buildAgentSessionMap([
      toolCall('Read', 'running', {
        body: { kind: 'tool-call', name: 'Read', input: { file_path: '/a/b.ts' }, state: 'running' }
      }),
      toolCall('Bash', 'running', {
        body: { kind: 'tool-call', name: 'Bash', input: 'ls -la\nmore', state: 'running' }
      }),
      toolCall('Mystery', 'running', {
        body: { kind: 'tool-call', name: 'Mystery', input: null, state: 'running' }
      })
    ])
    expect(map.nodes[0].toolCalls.map((call) => call.summary)).toEqual(['/a/b.ts', 'ls -la', ''])
  })
})
