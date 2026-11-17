import { describe, expect, it } from 'vitest'
import type { OrcaCloudAgentsStatus } from '../../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import {
  overviewRows,
  type OverviewHost,
  type OverviewProbe
} from './agent-accounts-overview-model'

function host(over: Partial<OverviewHost> & Pick<OverviewHost, 'hostId' | 'kind'>): OverviewHost {
  return {
    label: over.hostId,
    availability: 'available',
    health: 'available',
    environmentId: 'env',
    ...over
  }
}

const REPORT = {
  checkedAt: 1_731_000_000_000,
  agents: [
    { agent: 'claude', state: 'signedIn', method: 'cliLogin' },
    { agent: 'codex', state: 'signedOut' }
  ]
} as const satisfies OverviewProbe['report']

function probe(over: Partial<OverviewProbe> = {}): OverviewProbe {
  return { report: REPORT, checking: false, failed: false, expired: [], ...over }
}

const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'active', label: 'a@acme.dev' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: true } }
}

describe('overviewRows', () => {
  it('uses the §7 vocabulary for hosts and one Orca Cloud row', () => {
    const rows = overviewRows({
      hosts: [host({ hostId: 'ssh:devbox', kind: 'sshOrcad' })],
      probes: { 'ssh:devbox': probe() },
      cloud: { status: STATUS, keyKinds: { claude: null, codex: 'team' }, member: false }
    })
    expect(rows.map((row) => [row.id, row.cells.claude.kind, row.cells.codex.kind])).toEqual([
      ['orca-cloud', 'cloudAccount', 'cloudKey'],
      ['ssh:devbox', 'signedIn', 'signedOut']
    ])
    expect(rows[1]?.action).toEqual({ kind: 'review', agent: 'codex' })
    expect(rows[0]).toMatchObject({ hostId: null, action: { kind: 'manage' } })
  })

  it('shows a host that can’t answer by its last verdict and date, never as checking', () => {
    const [row] = overviewRows({
      hosts: [host({ hostId: 'runtime:wsl', kind: 'wsl', availability: 'stopped' })],
      probes: { 'runtime:wsl': probe() },
      cloud: null
    })
    expect(row?.cells.claude).toEqual({ kind: 'signedInChecked', checkedAt: REPORT.checkedAt })
    const [unknown] = overviewRows({
      hosts: [host({ hostId: 'runtime:x', kind: 'paired', availability: 'unreachable' })],
      probes: { 'runtime:x': probe({ report: null }) },
      cloud: null
    })
    expect(unknown?.cells.claude.kind).toBe('notConnected')
  })

  it('pins This computer, then Orca Cloud, then attention rows', () => {
    const rows = overviewRows({
      hosts: [
        host({ hostId: 'ssh:a', kind: 'sshOrcad' }),
        host({ hostId: 'ssh:b', kind: 'sshOrcad' }),
        host({ hostId: 'local', kind: 'local', environmentId: null })
      ],
      probes: { 'ssh:b': probe({ report: null, failed: true }), local: probe() },
      cloud: { status: STATUS, keyKinds: { claude: null, codex: 'team' }, member: false }
    })
    expect(rows.map((row) => row.id)).toEqual(['local', 'orca-cloud', 'ssh:b', 'ssh:a'])
  })

  it('puts rows that need attention first (expired, couldn’t check)', () => {
    const rows = overviewRows({
      hosts: [
        host({ hostId: 'ssh:a', kind: 'sshOrcad' }),
        host({ hostId: 'ssh:b', kind: 'sshOrcad' })
      ],
      probes: {
        'ssh:a': probe(),
        'ssh:b': probe({ report: null, failed: true })
      },
      cloud: null
    })
    expect(rows.map((row) => [row.id, row.attention, row.action?.kind])).toEqual([
      ['ssh:b', true, 'checkAgain'],
      ['ssh:a', false, 'review']
    ])
    const [expired] = overviewRows({
      hosts: [host({ hostId: 'ssh:a', kind: 'sshOrcad' })],
      probes: { 'ssh:a': probe({ expired: ['codex'] }) },
      cloud: null
    })
    expect(expired?.cells.codex.kind).toBe('expired')
    expect(expired?.attention).toBe(true)
  })

  it('changes only the Orca Cloud cells under the kill switch or a provider never offered', () => {
    const rows = overviewRows({
      hosts: [],
      probes: {},
      cloud: {
        status: {
          ...STATUS,
          credentials: {
            ...STATUS.credentials,
            providerEnabled: { claude: false, codex: false },
            providerState: { claude: 'disabled', codex: 'off' }
          },
          sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
        },
        keyKinds: { claude: null, codex: null },
        member: true
      }
    })
    expect([rows[0]?.cells.claude.kind, rows[0]?.cells.codex.kind]).toEqual([
      'cloudPaused',
      'cloudNotOffered'
    ])
  })

  it('reads classic SSH like any host: its report while connected, not connected otherwise', () => {
    const [live] = overviewRows({
      hosts: [host({ hostId: 'ssh:old', kind: 'sshClassic', environmentId: null })],
      probes: { 'ssh:old': probe() },
      cloud: null
    })
    expect(live?.cells.claude.kind).toBe('signedIn')
    const [away] = overviewRows({
      hosts: [
        host({
          hostId: 'ssh:old',
          kind: 'sshClassic',
          environmentId: null,
          availability: 'disconnected'
        })
      ],
      probes: { 'ssh:old': probe({ report: null }) },
      cloud: null
    })
    expect(away?.cells.claude.kind).toBe('notConnected')
  })

  it('flags an API key overriding a CLI login (hasLogin) as needing attention', () => {
    const [row] = overviewRows({
      hosts: [host({ hostId: 'ssh:old', kind: 'sshClassic', environmentId: null })],
      probes: {
        'ssh:old': probe({
          report: {
            checkedAt: 1,
            agents: [
              { agent: 'claude', state: 'signedIn', method: 'apiKey', hasLogin: true },
              { agent: 'codex', state: 'signedIn', method: 'apiKey', hasLogin: false }
            ]
          }
        })
      },
      cloud: null
    })
    expect([row?.cells.claude.kind, row?.cells.codex.kind]).toEqual(['apiKeyOverrides', 'apiKey'])
    expect(row?.attention).toBe(true)
    expect(row?.action).toEqual({ kind: 'review', agent: 'claude' })
  })
})
