// RS-2: a sign-in whose auth check failed ("needs check") reaches the desktop as `expired` plus
// `needsCheck: true`. Every desktop, old ones included, then shows the Renew strip; an unknown state would
// have read as 'none' ("isn't set up"). The wire never sends a state an old desktop could read as active.
import { describe, expect, it } from 'vitest'
import {
  AgentCredentialsResponseSchema,
  isUsableAgentCredential
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { cloudAgentHoldReason } from './cloud-agent-launch-hold'

const wire = {
  claude: { state: 'expired', needsCheck: true, label: 'ada@example.com' },
  codex: { state: 'none' },
  providerEnabled: { claude: true, codex: true }
}

describe('RS-2 "needs check" on the wire', () => {
  it('parses as expired (needsCheck tolerated), never usable', () => {
    const parsed = AgentCredentialsResponseSchema.parse(wire)
    expect(parsed.claude.state).toBe('expired')
    expect(isUsableAgentCredential(parsed.claude.state)).toBe(false)
  })

  it('maps to the Renew strip (accountExpired), like any expired sign-in', () => {
    const parsed = AgentCredentialsResponseSchema.parse(wire)
    expect(
      cloudAgentHoldReason('claude', {
        load: {
          kind: 'ready',
          status: {
            credentials: parsed,
            sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
          }
        },
        keyKinds: { claude: null, codex: null }
      })
    ).toBe('accountExpired')
  })

  it('a raw unknown state (what an old server could never send) still never reads as active', () => {
    const parsed = AgentCredentialsResponseSchema.parse({ ...wire, claude: { state: 'suspect' } })
    expect(parsed.claude.state).toBe('none')
    expect(isUsableAgentCredential(parsed.claude.state)).toBe(false)
  })
})
