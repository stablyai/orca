import { describe, expect, it } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  agentKeyKinds,
  orcaCloudAccountRow,
  orcaCloudAgentCoverage
} from './orca-cloud-agent-accounts-model'

function status(overrides: {
  claude?: OrcaCloudAgentsStatus['credentials']['claude']
  enabled?: boolean
  covered?: boolean
  defaultSource?: 'sign-in' | 'key' | null
}): OrcaCloudAgentsStatus {
  return {
    credentials: {
      claude: overrides.claude ?? { state: 'none' },
      codex: { state: 'none' },
      providerEnabled: { claude: overrides.enabled ?? true, codex: true }
    },
    sources: {
      defaults: { claude: overrides.defaultSource ?? null },
      coveredByKey: { claude: overrides.covered ?? false, codex: false }
    }
  }
}

const IDLE = { phase: 'idle' } as const
const ACTIVE = { state: 'active', label: 'a@acme.dev', expiresAt: 10 } as const

describe('agentKeyKinds', () => {
  it('names the winning key: team, then repository, then personal', () => {
    expect(
      agentKeyKinds([
        { name: 'ANTHROPIC_API_KEY', scope: 'personal' },
        { name: 'AI_GATEWAY_API_KEY', scope: 'org' },
        { name: 'OPENAI_API_KEY', scope: 'repo' },
        { name: 'DATABASE_URL', scope: 'org' }
      ])
    ).toEqual({ claude: 'team', codex: 'team' })
    expect(agentKeyKinds([{ name: 'OPENAI_API_KEY', scope: 'personal' }])).toEqual({
      claude: null,
      codex: 'personal'
    })
  })
})

describe('orcaCloudAccountRow', () => {
  it('walks the S0 states', () => {
    expect(orcaCloudAccountRow('claude', status({}), IDLE, null)).toEqual({
      kind: 'notSetUp',
      keyKind: null
    })
    expect(orcaCloudAccountRow('claude', status({ covered: true }), IDLE, 'team')).toEqual({
      kind: 'notSetUp',
      keyKind: 'team'
    })
    // State 7: set up while a key covers it, and no default chosen yet.
    expect(
      orcaCloudAccountRow('claude', status({ claude: ACTIVE, covered: true }), IDLE, 'team').kind
    ).toBe('choice')
    expect(
      orcaCloudAccountRow(
        'claude',
        status({ claude: ACTIVE, covered: true, defaultSource: 'key' }),
        IDLE,
        'team'
      )
    ).toMatchObject({ kind: 'active', source: 'key', covered: true })
    expect(orcaCloudAccountRow('claude', status({ claude: ACTIVE }), IDLE, null)).toMatchObject({
      kind: 'active',
      source: 'sign-in',
      label: 'a@acme.dev',
      expiring: false
    })
    expect(
      orcaCloudAccountRow('claude', status({ claude: { state: 'expiring' } }), IDLE, null)
    ).toMatchObject({ kind: 'active', expiring: true, label: null })
    expect(
      orcaCloudAccountRow('claude', status({ claude: { state: 'revoked' } }), IDLE, null)
    ).toEqual({ kind: 'expired', keyKind: null, covered: false })
  })

  it('puts the kill switch first, then a running or failed setup', () => {
    expect(
      orcaCloudAccountRow('claude', status({ claude: ACTIVE, enabled: false }), IDLE, null)
    ).toEqual({ kind: 'killSwitch' })
    const browser = { phase: 'browser', startedAt: 1, canReopen: false } as const
    expect(orcaCloudAccountRow('claude', status({}), browser, null)).toEqual({
      kind: 'setup',
      setup: browser
    })
    expect(
      orcaCloudAccountRow('claude', status({}), { phase: 'failed', error: 'denied' }, null)
    ).toEqual({ kind: 'failed', error: 'denied' })
  })
})

describe('orcaCloudAgentCoverage', () => {
  it('says how a new cloud workspace authenticates', () => {
    expect(orcaCloudAgentCoverage('claude', status({ claude: ACTIVE }), null)).toEqual({
      kind: 'account'
    })
    expect(
      orcaCloudAgentCoverage('claude', status({ claude: ACTIVE, covered: true }), 'team')
    ).toEqual({ kind: 'key', keyKind: 'team' })
    expect(
      orcaCloudAgentCoverage(
        'claude',
        {
          ...status({ claude: ACTIVE, covered: true }),
          sources: {
            defaults: { claude: 'sign-in' },
            effective: { claude: { source: 'sign-in' } },
            coveredByKey: { claude: true, codex: false }
          }
        },
        'team'
      )
    ).toEqual({ kind: 'account' })
    expect(orcaCloudAgentCoverage('claude', status({}), null)).toEqual({ kind: 'notSetUp' })
    expect(
      orcaCloudAgentCoverage('claude', status({ claude: { state: 'expired' } }), null)
    ).toEqual({ kind: 'expired' })
    // Kill switch: a key still covers it; otherwise each workspace signs in.
    expect(
      orcaCloudAgentCoverage('claude', status({ claude: ACTIVE, enabled: false }), null)
    ).toEqual({ kind: 'killSwitch' })
    expect(
      orcaCloudAgentCoverage(
        'claude',
        status({ claude: ACTIVE, enabled: false, covered: true }),
        'personal'
      )
    ).toEqual({ kind: 'key', keyKind: 'personal' })
  })
})
