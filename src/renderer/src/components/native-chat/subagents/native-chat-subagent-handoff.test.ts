import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import { nativeChatSubagentHandoff } from './native-chat-subagent-handoff'

function row(id: string, blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id, role: 'assistant', blocks, timestamp: 1, source: 'transcript' }
}

describe('nativeChatSubagentHandoff', () => {
  it("reads a Claude subagent's prompt and reply from the Agent call its run names", () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handoff reads only each item's body blocks.
    const journalItems = [
      {
        itemId: 'spawn',
        revision: 1,
        sequence: 2,
        observedAt: 1,
        body: {
          kind: 'message',
          role: 'assistant',
          blocks: [
            {
              type: 'subagent',
              id: 'agent-a',
              label: 'List src',
              state: 'completed',
              groupId: 'g',
              run: 'toolu_2'
            }
          ]
        }
      }
    ] as unknown as AgentJournalRenderItem[]
    const conversation = [
      row('call', [
        { type: 'tool-call', name: 'Agent', callId: 'toolu_1', input: { prompt: 'Other task' } },
        { type: 'tool-call', name: 'Agent', callId: 'toolu_2', input: { prompt: 'List src/' } },
        { type: 'tool-result', callId: 'toolu_1', output: 'Other reply' },
        {
          type: 'tool-result',
          callId: 'toolu_2',
          output:
            '  <tools-used-before-summary>Bash</tools-used-before-summary>\n  \n[Subagent hand-back] The report follows:\n  src holds:\n  \n  - `math.ts`'
        }
      ])
    ]
    expect(
      nativeChatSubagentHandoff({
        agentId: 'agent-a',
        journalItems,
        conversation,
        subagentRows: new Map()
      })
    ).toEqual({ prompt: 'List src/', reply: 'src holds:\n\n- `math.ts`', error: null })
  })

  it("reads a Codex subagent's prompt from the spawn call naming it, leaving its reply to its own rows", () => {
    const conversation = [
      row('spawn', [
        {
          type: 'tool-call',
          name: 'spawn_agent',
          callId: 'call_1',
          input: { agents: ['thread-child'], prompt: 'Map token refresh' }
        },
        { type: 'tool-result', callId: 'call_1', output: 'Spawned' }
      ])
    ]
    expect(
      nativeChatSubagentHandoff({
        agentId: 'thread-child',
        journalItems: [],
        conversation,
        subagentRows: new Map()
      })
    ).toEqual({ prompt: 'Map token refresh', reply: null, error: null })
  })
})
