import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { agentsSummary } from './CloudAgentsAndSecretsLink'

describe('agentsSummary', () => {
  it('uses the NP-3 wording, grouped by source', () => {
    expect(
      agentsSummary(
        [
          { agent: 'claude', coverage: { kind: 'account' } },
          { agent: 'codex', coverage: { kind: 'key', keyKind: 'team' } }
        ],
        translate
      )
    ).toBe('Claude from your Orca account · Codex with the team key')
    expect(
      agentsSummary(
        [
          { agent: 'claude', coverage: { kind: 'account' } },
          { agent: 'codex', coverage: { kind: 'notSetUp' } }
        ],
        translate
      )
    ).toBe('Claude from your Orca account · Codex not set up')
  })
})
