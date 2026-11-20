import { defineFixture } from '../../component-fixtures/component-fixture'
import { buildAgentSessionMap } from '../../../../shared/agent-session-map/build-agent-session-map'
import { mapStateAt } from '../../../../shared/agent-session-map/agent-session-map-playhead'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { layoutAgentMap } from '../../../../shared/agent-session-map/agent-session-map-layout'
import { AgentSessionMapGraph } from './AgentSessionMapGraph'
import { AgentSessionMapTimeline } from './AgentSessionMapTimeline'

let seq = 0
let ts = 1_700_000_000_000
function nextTs(): number {
  ts += 1500
  return ts
}

function item(
  body: AgentJournalRenderItem['body'],
  linkage?: { agentId?: string; parentAgentId?: string }
): AgentJournalRenderItem {
  seq += 1
  return {
    itemId: `item-${seq}`,
    sequence: seq,
    sequenceIndex: 0,
    revision: 1,
    observedAt: nextTs(),
    ...linkage,
    body
  }
}

function toolCall(
  name: string,
  state: 'running' | 'completed' | 'failed',
  input: Record<string, unknown>,
  linkage?: { agentId?: string }
): AgentJournalRenderItem {
  return item({ kind: 'tool-call', callId: `${name}-${seq}`, name, input, state }, linkage)
}

function syntheticJournal(): AgentJournalRenderItem[] {
  return [
    item({
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: 'Refactor the auth module' }]
    }),
    toolCall('Bash', 'completed', { command: 'pnpm test auth' }),
    item({
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'turn-1',
          agents: [
            { id: 'a1', label: 'Explore the auth code', state: 'working' },
            { id: 'a2', label: 'Check the tests', state: 'completed', settledAt: nextTs() }
          ]
        }
      ]
    }),
    toolCall('Read', 'completed', { file_path: 'src/auth/session.ts' }, { agentId: 'a1' }),
    item(
      {
        kind: 'message',
        role: 'system',
        blocks: [
          {
            type: 'subagent-group',
            groupId: 'turn-1-a1',
            agents: [{ id: 'a3', label: 'Trace token flow', state: 'working' }]
          }
        ]
      },
      { parentAgentId: 'a1' }
    ),
    toolCall('Grep', 'running', { pattern: 'token' }, { agentId: 'a2' }),
    toolCall('Read', 'running', { file_path: 'src/auth/tokens.ts' }, { agentId: 'a3' }),
    item({
      kind: 'diff',
      path: 'src/auth/session.ts',
      patch: { head: '@@ -1 +1 @@', byteLength: 42, digest: 'ab'.repeat(32), truncated: false }
    }),
    item({
      kind: 'question',
      question: 'Which token format should the refactor keep?',
      options: [
        { id: 'o1', label: 'JWT' },
        { id: 'o2', label: 'Opaque session id' }
      ],
      resolution: {
        state: 'pending',
        selectedOptionId: null,
        resolvedBy: null,
        resolvedAt: null
      }
    }),
    toolCall('Edit', 'running', { file_path: 'src/auth/session.ts' })
  ]
}

function renderMap(playheadTs: number | null): React.JSX.Element {
  const map = buildAgentSessionMap(syntheticJournal())
  const layout = layoutAgentMap(map, 720, { chipRowHeight: 20 })
  const viewState = mapStateAt(map, playheadTs)
  const playheadIndex =
    playheadTs === null
      ? null
      : map.timeline.reduce((acc, event, i) => (event.ts <= playheadTs ? i : acc), 0)
  return (
    <div className="flex h-full w-full flex-col bg-background">
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        <AgentSessionMapGraph map={map} layout={layout} viewState={viewState} />
      </div>
      <div className="border-t border-border px-4 py-3">
        <AgentSessionMapTimeline
          timeline={map.timeline}
          playheadIndex={playheadIndex}
          onScrub={() => {}}
        />
      </div>
    </div>
  )
}

export const live = defineFixture({
  width: 720,
  render: () => renderMap(null)
})

export const scrubbed = defineFixture({
  width: 720,
  render: () => renderMap(1_700_000_003_000)
})
