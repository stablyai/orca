import { describe, expect, it } from 'vitest'
import { resolveAgentStatusIdentity } from './agent-status-identity'
import type { AgentProcessIdentity } from './agent-process-presence'

describe.each(['darwin', 'linux', 'win32'] as const)(
  'same-agent process ownership on %s',
  (platform) => {
    const owner: AgentProcessIdentity = { pid: 4001, platform, startTime: 'owner-birth' }
    const existing = {
      agentType: 'claude',
      state: 'done' as const,
      updatedAt: 1,
      agentPresence: { agent: 'claude', process: owner, sessionOwner: true as const }
    }

    it('fences a different Claude process even while the owner is idle and its last hook is old', () => {
      expect(
        resolveAgentStatusIdentity({
          existing,
          incoming: 'claude',
          incomingProcess: { ...owner, pid: 5001 },
          now: 24 * 60 * 60_000
        })
      ).toEqual({ agentType: 'claude', inheritedFromActivePane: true })
    })

    it('distinguishes a reused PID by its start marker', () => {
      expect(
        resolveAgentStatusIdentity({
          existing,
          incoming: 'claude',
          incomingProcess: { ...owner, startTime: 'replacement-birth' },
          now: 2
        }).inheritedFromActivePane
      ).toBe(true)
    })

    it('keeps same-process session changes and older hooks without process evidence compatible', () => {
      for (const incomingProcess of [owner, undefined]) {
        expect(
          resolveAgentStatusIdentity({ existing, incoming: 'claude', incomingProcess, now: 2 })
            .inheritedFromActivePane
        ).toBe(false)
      }
    })
  }
)
