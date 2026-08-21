import { describe, expect, it } from 'vitest'
import { createHookListenerState, type AgentHookEventPayload } from './agent-hook-listener'
import { upsertBoundedAgentHookStatus } from './agent-hook-status-cache'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-status-types'

function status(
  paneKey: string,
  state: AgentHookEventPayload['payload']['state'],
  receivedAt: number
): AgentHookEventPayload {
  return {
    paneKey,
    connectionId: null,
    payload: { state, prompt: paneKey, agentType: 'claude' },
    receivedAt
  } as AgentHookEventPayload
}

describe('bounded agent hook status cache', () => {
  it('preserves the current row and falls back to least-recently-updated eviction', () => {
    const listener = createHookListenerState()
    const now = Date.now()
    upsertBoundedAgentHookStatus(listener, status('oldest', 'working', now), { maxPanes: 2, now })
    upsertBoundedAgentHookStatus(listener, status('newer', 'working', now), { maxPanes: 2, now })

    const evicted = upsertBoundedAgentHookStatus(listener, status('current', 'working', now), {
      maxPanes: 2,
      now
    })

    expect(evicted.map(({ paneKey }) => paneKey)).toEqual(['oldest'])
    expect([...listener.lastStatusByPaneKey.keys()]).toEqual(['newer', 'current'])
  })

  it('prefers the oldest completed or stale row and clears its related pane caches', () => {
    const listener = createHookListenerState()
    const now = Date.now()
    upsertBoundedAgentHookStatus(listener, status('fresh-oldest', 'working', now), {
      maxPanes: 3,
      now
    })
    upsertBoundedAgentHookStatus(listener, status('stale', 'working', now), {
      maxPanes: 3,
      now
    })
    upsertBoundedAgentHookStatus(listener, status('done', 'done', now), { maxPanes: 3, now })
    const stale = listener.lastStatusByPaneKey.get('stale') as AgentHookEventPayload & {
      receivedAt: number
    }
    stale.receivedAt = now - AGENT_STATUS_STALE_AFTER_MS - 1
    listener.lastPromptByPaneKey.set('stale', 'cached prompt')
    listener.lastToolByPaneKey.set('stale\0tool', {} as never)

    const evicted = upsertBoundedAgentHookStatus(listener, status('current', 'working', now), {
      maxPanes: 3,
      now
    })

    expect(evicted.map(({ paneKey }) => paneKey)).toEqual(['stale'])
    expect(listener.lastStatusByPaneKey.has('fresh-oldest')).toBe(true)
    expect(listener.lastStatusByPaneKey.has('done')).toBe(true)
    expect(listener.lastStatusByPaneKey.has('current')).toBe(true)
    expect(listener.lastPromptByPaneKey.has('stale')).toBe(false)
    expect(listener.lastToolByPaneKey.has('stale\0tool')).toBe(false)
  })
})
