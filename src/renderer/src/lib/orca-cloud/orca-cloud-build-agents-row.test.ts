import { describe, expect, it } from 'vitest'
import {
  IDLE_ORCA_CLOUD_AGENT_SETUPS,
  type OrcaCloudAgentsStatus
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  buildAgentsRow,
  buildAgentsRowDensity,
  buildAgentsToSetUp
} from './orca-cloud-build-agents-row'
import type { OrcaCloudAgentAccountsState } from './orca-cloud-agent-accounts-store'

const NONE: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'none' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
}

function accounts(
  status: OrcaCloudAgentsStatus,
  patch: Partial<OrcaCloudAgentAccountsState> = {}
): OrcaCloudAgentAccountsState {
  return {
    load: { kind: 'ready', status },
    setups: IDLE_ORCA_CLOUD_AGENT_SETUPS,
    keyKinds: { claude: null, codex: null },
    queue: { agents: [], index: 0 },
    ...patch
  }
}

function withClaude(
  state: OrcaCloudAgentsStatus['credentials']['claude']['state'],
  patch: Partial<OrcaCloudAgentsStatus['credentials']> = {}
): OrcaCloudAgentsStatus {
  return {
    ...NONE,
    credentials: { ...NONE.credentials, claude: { state, label: 'me@x.dev' }, ...patch }
  }
}

const row = (a: OrcaCloudAgentAccountsState) => buildAgentsRow({ accounts: a, desktopKeys: [] })

describe('buildAgentsRow', () => {
  it('offers the one-time setup when nothing covers any agent (R2), two lines at mount', () => {
    const model = row(accounts(NONE))
    expect(model).toEqual({ kind: 'offer', agents: ['claude', 'codex'] })
    expect(buildAgentsRowDensity(model)).toBe('twoLine')
    expect(buildAgentsToSetUp(model)).toEqual(['claude', 'codex'])
  })

  it('is a ready line naming each covered agent, without prompting for the rest', () => {
    const status: OrcaCloudAgentsStatus = {
      ...withClaude('active'),
      sources: { defaults: {}, coveredByKey: { claude: false, codex: true } }
    }
    const model = row(accounts(status, { keyKinds: { claude: null, codex: 'team' } }))
    expect(model).toEqual({
      kind: 'ready',
      covered: [
        { agent: 'claude', via: 'account' },
        { agent: 'codex', via: 'team' }
      ],
      label: null,
      expiring: null
    })
    expect(buildAgentsRowDensity(model)).toBe('line')
  })

  it('names the account when it covers every agent, and offers Renew when it is expiring', () => {
    const model = row(accounts(withClaude('expiring')))
    expect(model).toMatchObject({ kind: 'ready', label: 'me@x.dev', expiring: 'claude' })
    expect(buildAgentsToSetUp(model)).toEqual(['claude'])
  })

  it('puts the kill switch first, then an expiry, both only when no key covers the agent', () => {
    const paused = withClaude('active', { providerEnabled: { claude: false, codex: true } })
    expect(row(accounts(paused))).toEqual({ kind: 'killSwitch', agent: 'claude' })
    expect(row(accounts(withClaude('revoked')))).toEqual({ kind: 'expired', agent: 'claude' })
    const keyed = {
      ...paused,
      sources: { defaults: {}, coveredByKey: { claude: true, codex: false } }
    }
    expect(row(accounts(keyed, { keyKinds: { claude: 'personal', codex: null } }))).toMatchObject({
      kind: 'ready',
      covered: [{ agent: 'claude', via: 'personal' }]
    })
  })

  it('shows a running or failed setup over everything else, with its place in the queue', () => {
    const running = accounts(NONE, {
      setups: { claude: { phase: 'idle' }, codex: { phase: 'preparing', startedAt: 1 } },
      queue: { agents: ['claude', 'codex'], index: 1 }
    })
    expect(row(running)).toMatchObject({
      kind: 'setup',
      agent: 'codex',
      step: 2,
      of: 2
    })
    const failed = accounts(NONE, {
      setups: { claude: { phase: 'failed', error: 'denied' }, codex: { phase: 'idle' } }
    })
    expect(row(failed)).toEqual({ kind: 'failed', agent: 'claude', error: 'denied' })
  })

  it('offers saving a key only on this computer before the setup (S1-c)', () => {
    const key = { id: 'k1', agent: 'claude', envName: 'ANTHROPIC_API_KEY', hint: 'x4Qa' } as const
    expect(buildAgentsRow({ accounts: accounts(NONE), desktopKeys: [key] })).toEqual({
      kind: 'desktopKey',
      key
    })
  })

  it('loads, fails and hides from the account read alone, never the sandbox', () => {
    const base = accounts(NONE)
    expect(row({ ...base, load: { kind: 'loading' } })).toEqual({ kind: 'loading' })
    expect(row({ ...base, load: { kind: 'failed', error: 'unavailable' } })).toEqual({
      kind: 'error'
    })
    expect(row({ ...base, load: { kind: 'unavailable' } })).toEqual({ kind: 'hidden' })
    expect(buildAgentsRowDensity({ kind: 'loading' })).toBe('twoLine')
  })
})
