import React from 'react'
import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { OrcaCloudAgentsStatus } from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import type { HostAgentSignInReport } from '../../../../../shared/host-agent-sign-in-status'
import type { SshAgentSignInReport } from '../../../../../shared/ssh-agent-sign-in-types'
import {
  overviewRows,
  type OverviewHost,
  type OverviewProbe
} from './overview/agent-accounts-overview-model'
import { AgentAccountsOverview } from './overview/AgentAccountsOverview'

const noop = (): void => {}
const CHECKED = 1_762_700_000_000

function report(
  claude: 'signedIn' | 'signedOut' | 'notInstalled',
  codex: 'signedIn' | 'signedOut' | 'notInstalled',
  claudeApiKey = false
): HostAgentSignInReport {
  return {
    checkedAt: CHECKED,
    agents: [
      { agent: 'claude', state: claude, ...(claudeApiKey ? { method: 'apiKey' as const } : {}) },
      { agent: 'codex', state: codex }
    ]
  }
}

function host(
  hostId: OverviewHost['hostId'],
  label: string,
  kind: OverviewHost['kind'],
  availability: OverviewHost['availability'] = 'available'
): OverviewHost {
  return { hostId, label, kind, availability, health: 'available', environmentId: hostId }
}

function probe(
  value: SshAgentSignInReport | null,
  over: Partial<OverviewProbe> = {}
): OverviewProbe {
  return { report: value, checking: false, failed: false, expired: [], ...over }
}

const LOCAL = host('local', 'MacBook Pro', 'local')
const DEVBOX = host('runtime:devbox', 'devbox', 'sshOrcad')
const GPU = host('runtime:gpu', 'gpu-box', 'paired')

const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'active', label: 'a@acme.dev' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: true } }
}
const CLOUD = { status: STATUS, keyKinds: { claude: null, codex: 'team' as const }, member: false }

function Frame(props: React.ComponentProps<typeof AgentAccountsOverview>): React.JSX.Element {
  return (
    <div className="bg-background p-6">
      <div className="mx-auto max-w-[760px]">
        <AgentAccountsOverview {...props} />
      </div>
    </div>
  )
}

const BASE = {
  signedOutOfOrca: false,
  summary: '',
  onOpenRow: noop,
  onAction: noop
}

const OVERVIEW_PROBES = {
  local: probe(report('signedIn', 'signedIn')),
  'runtime:devbox': probe(report('signedIn', 'signedOut')),
  'runtime:gpu': probe(report('signedIn', 'notInstalled', true))
}

export const overview = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({ hosts: [LOCAL, DEVBOX, GPU], probes: OVERVIEW_PROBES, cloud: CLOUD })}
    />
  )
})

/** RA-5: the Needs attention filter with nothing in it says so instead of an empty table. */
export const nothingNeedsAttention = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      initialFilter="attention"
      rows={overviewRows({ hosts: [LOCAL], probes: OVERVIEW_PROBES, cloud: CLOUD })}
    />
  )
})

export const needsAttention = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL, DEVBOX, GPU],
        probes: {
          ...OVERVIEW_PROBES,
          'runtime:devbox': probe(report('signedIn', 'signedOut'), { expired: ['codex'] }),
          'runtime:gpu': probe(null, { failed: true })
        },
        cloud: CLOUD
      })}
    />
  )
})

export const asleep = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [
          LOCAL,
          host('runtime:vm', 'gpu-vm', 'recipe', 'suspended'),
          host('runtime:wsl', 'Ubuntu-24.04', 'wsl', 'stopped')
        ],
        probes: {
          local: probe(report('signedIn', 'signedIn')),
          'runtime:vm': probe(report('signedIn', 'signedOut')),
          'runtime:wsl': probe(null)
        },
        cloud: CLOUD
      })}
    />
  )
})

export const loading = defineFixture({
  width: 860,
  render: () => <Frame {...BASE} rows={[]} loading />
})

export const checking = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL, DEVBOX],
        probes: {
          local: probe(null, { checking: true }),
          'runtime:devbox': probe(null, { checking: true })
        },
        cloud: CLOUD
      })}
    />
  )
})

export const signedOutOfOrca = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      signedOutOfOrca
      rows={overviewRows({ hosts: [LOCAL, DEVBOX], probes: OVERVIEW_PROBES, cloud: null })}
    />
  )
})

export const empty = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({ hosts: [LOCAL], probes: OVERVIEW_PROBES, cloud: null })}
    />
  )
})

export const member = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL, DEVBOX],
        probes: OVERVIEW_PROBES,
        cloud: { ...CLOUD, member: true }
      })}
    />
  )
})

export const killSwitch = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL],
        probes: OVERVIEW_PROBES,
        cloud: {
          ...CLOUD,
          status: {
            ...STATUS,
            credentials: {
              ...STATUS.credentials,
              providerEnabled: { claude: false, codex: false },
              providerState: { claude: 'disabled', codex: 'off' }
            },
            sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
          }
        }
      })}
    />
  )
})

const MANY = Array.from({ length: 9 }, (_, index) =>
  host(
    `runtime:host-${index}`,
    `build-${String(index + 1).padStart(2, '0')}`,
    index % 3 === 0 ? 'wsl' : 'sshOrcad'
  )
)

export const manyHosts = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL, ...MANY],
        probes: Object.fromEntries([
          ['local', probe(report('signedIn', 'signedIn'))],
          ...MANY.map((entry, index) => [
            entry.hostId,
            probe(report(index % 4 === 0 ? 'signedOut' : 'signedIn', 'signedIn'))
          ])
        ]),
        cloud: CLOUD
      })}
    />
  )
})

const CLASSIC = host('ssh:build-01', 'build-01', 'sshClassic')

/** Classic SSH reports an API key overriding a sign-in (hasLogin); it needs attention. */
export const keyOverrides = defineFixture({
  width: 860,
  render: () => (
    <Frame
      {...BASE}
      rows={overviewRows({
        hosts: [LOCAL, CLASSIC],
        probes: {
          local: probe(report('signedIn', 'signedIn')),
          'ssh:build-01': probe({
            checkedAt: CHECKED,
            agents: [
              { agent: 'claude', state: 'signedIn', method: 'apiKey', hasLogin: true },
              { agent: 'codex', state: 'signedIn', method: 'cliLogin' }
            ]
          })
        },
        cloud: CLOUD
      })}
    />
  )
})
