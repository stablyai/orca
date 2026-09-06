import { describe, expect, it } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import { selectStructuredAgentTurnActivity } from './native-chat-turn-activity'

function item(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

const turnStart = item(1, {
  kind: 'status',
  text: 'Codex is working…',
  turnLifecycle: { turnId: 'turn-1', state: 'running' }
})

describe('selectStructuredAgentTurnActivity', () => {
  it('prefers the latest provider-authored activity line in the active turn', () => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm test' },
          state: 'completed'
        }),
        item(3, { kind: 'status', text: 'Checking the results\nPreparing the answer' })
      ],
      'turn-1'
    )

    expect(activity).toEqual({ kind: 'description', text: 'Preparing the answer' })
  })

  it('ignores active and settled tools so the tail can use a broad fallback', () => {
    const activity = selectStructuredAgentTurnActivity(
      [
        turnStart,
        item(2, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm test' },
          state: 'running'
        }),
        item(3, {
          kind: 'tool-call',
          name: 'shell',
          input: { command: 'pnpm lint' },
          state: 'completed'
        })
      ],
      'turn-1'
    )

    expect(activity).toBeNull()
  })

  it('ignores diagnostic provider frames and returns nothing after the turn settles', () => {
    const diagnostic = item(2, {
      kind: 'status',
      text: 'codex · notification:new/event',
      providerFrame: {
        provider: 'codex',
        kind: 'notification:new/event',
        payload: {
          head: '{}',
          byteLength: 2,
          digest: 'a'.repeat(64),
          truncated: false
        }
      }
    })

    expect(selectStructuredAgentTurnActivity([turnStart, diagnostic], 'turn-1')).toBeNull()
    expect(selectStructuredAgentTurnActivity([turnStart, diagnostic], null)).toBeNull()
  })
})
