import { describe, expect, it } from 'vitest'
import type {
  AgentSourcesView,
  OrcaCloudAgentsStatus
} from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { cloudAgentPanelRows } from './cloud-agents-panel-model'

const ACTIVE = { state: 'active', label: 'a@acme.dev' } as const

function status(
  patch: Partial<OrcaCloudAgentsStatus['credentials']> = {},
  sources: Partial<AgentSourcesView> = {}
): OrcaCloudAgentsStatus {
  return {
    credentials: {
      claude: ACTIVE,
      codex: { state: 'none' },
      providerEnabled: { claude: true, codex: true },
      ...patch
    },
    sources: {
      defaults: {},
      coveredByKey: { claude: false, codex: true },
      ...sources
    }
  }
}

const KEYS = { claude: null, codex: 'team' } as const

describe('cloudAgentPanelRows', () => {
  it('reads from the Orca account: account with its email, or the winning key', () => {
    const rows = cloudAgentPanelRows(status(), KEYS, null)
    expect(rows).toEqual([
      { agent: 'claude', status: { kind: 'account', label: 'a@acme.dev' }, source: null },
      { agent: 'codex', status: { kind: 'key', keyKind: 'team' }, source: null }
    ])
  })

  it('offers the two-way Source only when both the account and a key could serve', () => {
    const both = status(
      { codex: { state: 'active' } },
      { defaults: { codex: 'key' }, coveredByKey: { claude: false, codex: true } }
    )
    const [, codex] = cloudAgentPanelRows(both, KEYS, null)
    expect(codex).toEqual({
      agent: 'codex',
      status: { kind: 'key', keyKind: 'team' },
      source: { value: 'key', keyKind: 'team' }
    })
  })

  it('uses this workspace’s override over the account default', () => {
    const both = status(
      { codex: { state: 'active' } },
      { defaults: { codex: 'key' }, coveredByKey: { claude: false, codex: true } }
    )
    const workspace: AgentSourcesView = {
      defaults: { codex: 'key' },
      effective: { codex: { source: 'sign-in' } },
      coveredByKey: { claude: false, codex: true }
    }
    const [, codex] = cloudAgentPanelRows(both, KEYS, workspace)
    expect(codex?.status).toEqual({ kind: 'account', label: null })
    expect(codex?.source?.value).toBe('sign-in')
  })

  it('tells the kill switch from a provider never offered, both signing in here', () => {
    const paused = status({
      providerEnabled: { claude: false, codex: true },
      providerState: { claude: 'disabled', codex: 'on' }
    })
    expect(cloudAgentPanelRows(paused, KEYS, null)[0]?.status).toEqual({
      kind: 'signsInHere',
      reason: 'paused'
    })
    const off = status({
      providerEnabled: { claude: false, codex: true },
      providerState: { claude: 'off', codex: 'on' }
    })
    expect(cloudAgentPanelRows(off, KEYS, null)[0]).toEqual({
      agent: 'claude',
      status: { kind: 'signsInHere', reason: 'notOffered' },
      source: null
    })
  })

  it('says not set up or expired when nothing covers the agent', () => {
    const none = status({ claude: { state: 'none' } })
    expect(cloudAgentPanelRows(none, KEYS, null)[0]?.status).toEqual({ kind: 'notSetUp' })
    const expired = status({ claude: { state: 'expired' } })
    expect(cloudAgentPanelRows(expired, KEYS, null)[0]?.status).toEqual({ kind: 'expired' })
  })
})
