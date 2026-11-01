import { describe, expect, it } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isAgentStatusFresh,
  isFreshNonDoneAgentStatus
} from './agent-status-freshness'

describe('isAgentStatusFresh', () => {
  const now = 1_000_000_000

  it('considers recent status entries fresh', () => {
    const entry = {
      state: 'working' as const,
      updatedAt: now - 5_000
    }
    expect(isAgentStatusFresh(entry, now)).toBe(true)
    expect(isFreshNonDoneAgentStatus(entry, now)).toBe(true)
  })

  it('considers normal status entries past stale threshold stale', () => {
    const entry = {
      state: 'working' as const,
      updatedAt: now - AGENT_STATUS_STALE_AFTER_MS - 1
    }
    expect(isAgentStatusFresh(entry, now)).toBe(false)
    expect(isFreshNonDoneAgentStatus(entry, now)).toBe(false)
  })

  it('keeps waiting interactive prompts fresh past the stale threshold', () => {
    const entry = {
      state: 'waiting' as const,
      updatedAt: now - 2 * 60 * 60 * 1000, // 2 hours old
      interactivePrompt: JSON.stringify({
        approval: { tool: 'Bash', summary: 'gh pr comment' }
      })
    }
    expect(isAgentStatusFresh(entry, now)).toBe(true)
    expect(isFreshNonDoneAgentStatus(entry, now)).toBe(true)
  })

  it('keeps blocked interactive prompts fresh past the stale threshold', () => {
    const entry = {
      state: 'blocked' as const,
      updatedAt: now - 2 * 60 * 60 * 1000, // 2 hours old
      interactivePrompt: JSON.stringify({
        approval: { tool: 'Bash', summary: 'reboot' }
      })
    }
    expect(isAgentStatusFresh(entry, now)).toBe(true)
    expect(isFreshNonDoneAgentStatus(entry, now)).toBe(true)
  })

  it('still considers restoredUnconfirmed entries stale even with interactivePrompt', () => {
    const entry = {
      state: 'waiting' as const,
      updatedAt: now - 5_000,
      restoredUnconfirmed: true,
      interactivePrompt: JSON.stringify({ approval: { tool: 'Bash' } })
    }
    expect(isAgentStatusFresh(entry, now)).toBe(false)
    expect(isFreshNonDoneAgentStatus(entry, now)).toBe(false)
  })
})
