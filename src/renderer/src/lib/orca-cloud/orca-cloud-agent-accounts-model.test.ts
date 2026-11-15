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
  /** Omitted: an older server that sends only providerEnabled. */
  provider?: 'on' | 'off' | 'disabled'
  covered?: boolean
  defaultSource?: 'sign-in' | 'key' | null
  /** The person signs Claude in inside each workspace. */
  inWorkspace?: boolean
  /** The view is for one workspace whose own Source overrides the default. */
  workspaceOverride?: 'sign-in' | 'key'
}): OrcaCloudAgentsStatus {
  return {
    credentials: {
      claude: overrides.claude ?? { state: 'none' },
      codex: { state: 'none' },
      providerEnabled: { claude: overrides.enabled ?? true, codex: true },
      ...(overrides.provider ? { providerState: { claude: overrides.provider, codex: 'on' } } : {})
    },
    sources: {
      defaults: { claude: overrides.defaultSource ?? null },
      coveredByKey: { claude: overrides.covered ?? false, codex: false },
      ...(overrides.inWorkspace !== undefined
        ? { inWorkspace: { claude: overrides.inWorkspace, codex: false } }
        : {}),
      ...(overrides.workspaceOverride
        ? { effective: { claude: { source: overrides.workspaceOverride, origin: 'workspace' } } }
        : {})
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
    expect(
      orcaCloudAccountRow(
        'claude',
        status({ claude: ACTIVE, enabled: false, provider: 'disabled' }),
        IDLE,
        null
      )
    ).toEqual({ kind: 'killSwitch' })
    expect(orcaCloudAccountRow('claude', status({}), browser, null)).toEqual({
      kind: 'setup',
      setup: browser
    })
    expect(
      orcaCloudAccountRow('claude', status({}), { phase: 'failed', error: 'denied' }, null)
    ).toEqual({ kind: 'failed', error: 'denied' })
  })
})

describe('flag off vs kill switch', () => {
  it('reads a never-offered provider as unavailable, not paused', () => {
    const off = status({ enabled: false, provider: 'off' })
    expect(orcaCloudAccountRow('claude', off, IDLE, null)).toEqual({ kind: 'unavailable' })
    expect(orcaCloudAgentCoverage('claude', off, null)).toEqual({ kind: 'unavailable' })
    // A key still covers it either way.
    expect(
      orcaCloudAgentCoverage(
        'claude',
        status({ enabled: false, provider: 'off', covered: true }),
        'team'
      )
    ).toEqual({ kind: 'key', keyKind: 'team' })
  })

  it('never trusts a providerState that contradicts providerEnabled', () => {
    expect(
      orcaCloudAccountRow('claude', status({ enabled: false, provider: 'on' }), IDLE, null)
    ).toEqual({ kind: 'killSwitch' })
    expect(
      orcaCloudAccountRow('claude', status({ enabled: true, provider: 'off' }), IDLE, null).kind
    ).toBe('notSetUp')
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

describe('signing in inside each workspace', () => {
  it('wins over a stored account and a covering key, in the S0 row and the coverage', () => {
    const chosen = status({ claude: ACTIVE, covered: true, inWorkspace: true })
    expect(orcaCloudAccountRow('claude', chosen, IDLE, 'team')).toEqual({
      kind: 'inWorkspace',
      savedSignIn: true
    })
    expect(orcaCloudAgentCoverage('claude', chosen, 'team')).toEqual({ kind: 'inWorkspace' })
    expect(orcaCloudAccountRow('claude', status({ inWorkspace: true }), IDLE, null)).toEqual({
      kind: 'inWorkspace',
      savedSignIn: false
    })
    // Codex keeps its own Source.
    expect(orcaCloudAgentCoverage('codex', chosen, null)).toEqual({ kind: 'notSetUp' })
  })

  it('gives way to a running setup, a provider that is off, and a workspace override', () => {
    const browser = { phase: 'browser', startedAt: 1, canReopen: true } as const
    expect(orcaCloudAccountRow('claude', status({ inWorkspace: true }), browser, null).kind).toBe(
      'setup'
    )
    expect(
      orcaCloudAccountRow(
        'claude',
        status({ inWorkspace: true, provider: 'off', enabled: false }),
        IDLE,
        null
      )
    ).toEqual({ kind: 'unavailable' })
    expect(
      orcaCloudAgentCoverage(
        'claude',
        status({ claude: ACTIVE, inWorkspace: true, workspaceOverride: 'sign-in' }),
        null
      )
    ).toEqual({ kind: 'account' })
  })

  it('an older server without the field changes nothing', () => {
    expect(orcaCloudAgentCoverage('claude', status({}), null)).toEqual({ kind: 'notSetUp' })
  })
})
