import { describe, expect, it } from 'vitest'
import type { AgentProcessPresence } from '../process/agent-process-presence'
import { resolveAgentStatusIdentity } from './agent-status-identity'

const now = 1_700_000_000_000
const processA = { pid: 100, platform: 'darwin' as const, startTime: '100' }
const processB = { pid: 200, platform: 'darwin' as const, startTime: '200' }

function working(
  agentType: 'opencode' | 'opencode2' | 'claude',
  agentPresence?: AgentProcessPresence
) {
  return { agentType, state: 'working' as const, updatedAt: now, agentPresence }
}

describe('resolveAgentStatusIdentity OpenCode family', () => {
  it('accepts an OpenCode 2 hook after OSC marked the pane opencode', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: working('opencode'),
        incoming: 'opencode2',
        now
      })
    ).toEqual({ agentType: 'opencode2', inheritedFromActivePane: false })
  })

  it('keeps OpenCode OSC on the same process as the OpenCode 2 owner', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: working('opencode2', {
          agent: 'opencode2',
          process: processA,
          session: 'ses',
          sessionOwner: true
        }),
        incoming: 'opencode',
        incomingProcess: processA,
        now
      })
    ).toEqual({ agentType: 'opencode', inheritedFromActivePane: false })
  })

  it('drops a nested OpenCode process inside an OpenCode 2 pane', () => {
    expect(
      resolveAgentStatusIdentity({
        existing: working('opencode2', {
          agent: 'opencode2',
          process: processA,
          session: 'ses',
          sessionOwner: true
        }),
        incoming: 'opencode',
        incomingProcess: processB,
        now
      }).inheritedFromActivePane
    ).toBe(true)
  })

  it('drops a different agent that starts while Claude is working', () => {
    const identity = resolveAgentStatusIdentity({
      existing: working('claude'),
      incoming: 'opencode2',
      now
    })
    expect(identity).toEqual({ agentType: 'claude', inheritedFromActivePane: true })
  })
})
