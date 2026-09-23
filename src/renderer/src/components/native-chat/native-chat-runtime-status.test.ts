import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { isNativeChatCompacting, selectNativeChatGoal } from './native-chat-runtime-status'

function goalItem(
  sequence: number,
  goal: Record<string, unknown>,
  kind = 'notification:thread/goal/updated'
): AgentJournalRenderItem {
  const payload = JSON.stringify({ goal })
  return {
    itemId: `goal-${sequence}`,
    revision: 1,
    sequence,
    observedAt: sequence * 1_000,
    body: {
      kind: 'status',
      text: 'goal',
      providerFrame: {
        provider: 'codex',
        kind,
        payload: {
          head: payload,
          byteLength: new TextEncoder().encode(payload).byteLength,
          digest: 'digest',
          truncated: false
        }
      }
    }
  }
}

describe('native chat runtime status', () => {
  it('projects the latest goal status, objective, and provider change time', () => {
    const items = [
      goalItem(1, { objective: 'Ship the parser', status: 'active', updatedAt: 1_789_067_988 }),
      goalItem(2, { objective: 'Ship the parser', status: 'paused', updatedAt: 1_789_067_999 })
    ]

    expect(selectNativeChatGoal(items)).toEqual({
      objective: 'Ship the parser',
      status: 'paused',
      updatedAt: 1_789_067_999_000
    })
  })

  it('removes a cleared goal and accepts a later resumed active goal', () => {
    const active = goalItem(1, {
      objective: 'Ship the parser',
      status: 'active',
      updatedAt: 1_789_067_988
    })
    const cleared = goalItem(2, {}, 'notification:thread/goal/cleared')
    expect(selectNativeChatGoal([active, cleared])).toBeNull()

    const resumed = goalItem(3, {
      objective: 'Ship the parser',
      status: 'active',
      updatedAt: 1_789_068_100
    })
    expect(selectNativeChatGoal([active, cleared, resumed])?.status).toBe('active')
  })

  it('does not infer a goal from malformed, truncated, or unknown provider state', () => {
    const truncated = goalItem(1, { objective: 'Hidden', status: 'active' })
    if (truncated.body.kind === 'status' && truncated.body.providerFrame) {
      truncated.body.providerFrame.payload.truncated = true
    }
    expect(selectNativeChatGoal([truncated])).toBeNull()
    expect(
      selectNativeChatGoal([goalItem(2, { objective: 'Hidden', status: 'future' })])
    ).toBeNull()
  })

  it('recognizes only the provider compacting activity', () => {
    expect(
      isNativeChatCompacting({ kind: 'description', text: 'Compacting the conversation' })
    ).toBe(true)
    expect(
      isNativeChatCompacting({ kind: 'description', text: 'Thinking through the request' })
    ).toBe(false)
    expect(isNativeChatCompacting(null)).toBe(false)
  })
})
