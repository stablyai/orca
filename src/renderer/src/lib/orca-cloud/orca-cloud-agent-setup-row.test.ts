import { describe, expect, it } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { orcaCloudAgentSetupRow } from './orca-cloud-agent-setup-row'
import type { OrcaCloudAgentAccountsLoad } from './orca-cloud-agent-accounts-store'

const READY: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'active', label: 'a@acme.dev' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: true } }
}
const ENTITLED = { state: 'entitled', remainingSeconds: 3600 } as const

function row(
  agent: string | null,
  load: OrcaCloudAgentAccountsLoad = { kind: 'ready', status: READY },
  access: Parameters<typeof orcaCloudAgentSetupRow>[0]['access'] = ENTITLED
) {
  return orcaCloudAgentSetupRow({
    agent,
    access,
    accounts: { load, keyKinds: { claude: null, codex: 'team' } }
  })
}

describe('orcaCloudAgentSetupRow', () => {
  it('reads "from your Orca account" or "team key" when the agent is covered', () => {
    expect(row('claude')).toEqual({ kind: 'covered', agent: 'claude', via: 'account' })
    expect(row('codex')).toEqual({ kind: 'covered', agent: 'codex', via: 'team' })
  })

  it('links to S0 when nothing covers the agent', () => {
    const none: OrcaCloudAgentsStatus = {
      ...READY,
      credentials: { ...READY.credentials, claude: { state: 'none' } }
    }
    expect(row('claude', { kind: 'ready', status: none })).toEqual({
      kind: 'notSetUp',
      agent: 'claude'
    })
  })

  it('is info only under the kill switch', () => {
    const paused: OrcaCloudAgentsStatus = {
      ...READY,
      credentials: { ...READY.credentials, providerEnabled: { claude: false, codex: true } }
    }
    expect(row('claude', { kind: 'ready', status: paused }).kind).toBe('killSwitch')
  })

  it('is hidden when this server never offered the provider (flag off)', () => {
    const off: OrcaCloudAgentsStatus = {
      ...READY,
      credentials: {
        ...READY.credentials,
        providerEnabled: { claude: false, codex: true },
        providerState: { claude: 'off', codex: 'on' }
      }
    }
    expect(row('claude', { kind: 'ready', status: off }).kind).toBe('hidden')
  })

  it('is hidden for agents without an account path, members blocked by billing, and GitHub blocks', () => {
    expect(row('cursor').kind).toBe('hidden')
    expect(row(null).kind).toBe('hidden')
    expect(
      row('claude', undefined, { state: 'no-plan', lapsed: false, canManageBilling: false }).kind
    ).toBe('hidden')
    expect(
      row('claude', undefined, { state: 'no-plan', lapsed: false, canManageBilling: true }).kind
    ).toBe('covered')
    expect(
      orcaCloudAgentSetupRow({
        agent: 'claude',
        access: ENTITLED,
        githubBlocked: true,
        accounts: {
          load: { kind: 'ready', status: READY },
          keyKinds: { claude: null, codex: null }
        }
      }).kind
    ).toBe('hidden')
  })

  it('has a signed-out, loading and error state, none of which block Start', () => {
    expect(row('claude', undefined, { state: 'signed-out' }).kind).toBe('signedOut')
    expect(row('claude', { kind: 'failed', error: 'signed_out' }).kind).toBe('signedOut')
    expect(row('claude', { kind: 'loading' }).kind).toBe('loading')
    expect(row('claude', { kind: 'failed', error: 'unavailable' }).kind).toBe('error')
    expect(row('claude', { kind: 'unavailable' }).kind).toBe('hidden')
  })
})
