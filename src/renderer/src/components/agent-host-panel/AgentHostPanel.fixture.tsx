import React from 'react'
import { Pencil, RefreshCw } from 'lucide-react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Sheet } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import type {
  CloudSecretsCaller,
  CloudSecretsEffective
} from '../../../../shared/cloud-secrets/cloud-secrets-wire'
import { CloudDesktopKeysOffer } from '../cloud-agent-setup/CloudDesktopKeysOffer'
import {
  CloudAgentKeysSection,
  CloudEnvironmentPanelSection
} from './cloud-sections/CloudPanelSections'
import {
  cloudPanelSectionsData,
  type CloudPanelSectionsLoad
} from './cloud-sections/use-cloud-panel-sections'
import { hostCapabilities, type AgentHostAvailability } from './agent-host-capabilities'
import { AgentHostPanelMenuItem } from './AgentHostPanelMenuItem'
import { AgentHostPanelView } from './AgentHostPanelView'
import { CloudAgentsPanelSection, type CloudAgentsPanelLoad } from './CloudAgentsPanelSection'
import type { CloudAgentPanelRow } from './cloud-agents-panel-model'

const noop = (): void => {}
const saved = async (): Promise<null> => null
const UPDATED = 1_731_000_000_000

function caller(role: 'admin' | 'member'): CloudSecretsCaller {
  const admin = role === 'admin'
  return {
    userId: admin ? 'u_ada' : 'u_bo',
    orgId: 'org_acme',
    orgRole: role,
    canWrite: { personal: true, org: admin, repo: admin }
  }
}

function secrets(role: 'admin' | 'member', asleep = false): CloudPanelSectionsLoad {
  const effective: CloudSecretsEffective = {
    caller: caller(role),
    precedence: { env: ['repo', 'personal', 'org'], agent_key: ['org', 'repo', 'personal'] },
    secrets: [
      {
        name: 'OPENAI_API_KEY',
        kind: 'agent_key',
        scope: 'org',
        hint: 'M3kz',
        updatedAt: UPDATED,
        shadowed: [{ scope: 'personal', hint: '9f2c' }]
      },
      {
        name: 'DATABASE_URL',
        kind: 'env',
        scope: 'repo',
        hint: null,
        updatedAt: UPDATED,
        shadowed: [{ scope: 'personal', hint: null }]
      }
    ]
  }
  return {
    status: 'ready',
    data: cloudPanelSectionsData({
      effective,
      envVarNames: ['DATABASE_URL', 'STRIPE_TEST_KEY'],
      repoKey: 'github.com/acme/web',
      asleep,
      sharing: null
    })
  }
}

const ROWS: CloudAgentPanelRow[] = [
  {
    agent: 'claude',
    status: { kind: 'account', label: 'a@acme.dev' },
    source: { value: 'sign-in', keyKind: 'team' }
  },
  { agent: 'codex', status: { kind: 'key', keyKind: 'team' }, source: null }
]

const READY_ROWS: CloudAgentsPanelLoad = { kind: 'ready', rows: ROWS }

function CloudPanel({
  availability = 'available',
  agents = READY_ROWS,
  load,
  desktopKey = false,
  sourceDisabledReason = null
}: {
  availability?: AgentHostAvailability
  agents?: CloudAgentsPanelLoad
  load?: CloudPanelSectionsLoad
  desktopKey?: boolean
  sourceDisabledReason?: string | null
}): React.JSX.Element {
  const capabilities = hostCapabilities(
    'cloud',
    availability,
    { host: 'Orca Cloud', date: null },
    translate
  )
  return (
    <div className="h-[860px] bg-background">
      <Sheet open modal={false}>
        <AgentHostPanelView
          capabilities={capabilities}
          subject="acme/web · fix-auth"
          dot={availability === 'asleep' ? 'sleeping' : 'running'}
          agents={
            <CloudAgentsPanelSection
              title={capabilities.agents.title}
              help={capabilities.agents.help}
              load={agents}
              sourceDisabledReason={sourceDisabledReason ?? capabilities.actionsDisabledReason}
              actions={{ chooseSource: noop, manage: noop, signIn: noop, retry: noop }}
            />
          }
          cloudSections={
            load ? (
              <>
                <CloudAgentKeysSection
                  load={load}
                  onRetry={noop}
                  onEdit={noop}
                  onManage={noop}
                  extraRows={
                    desktopKey ? (
                      <li className="py-2.5">
                        <CloudDesktopKeysOffer
                          keys={[
                            {
                              id: 'k1',
                              agent: 'claude',
                              envName: 'ANTHROPIC_API_KEY',
                              hint: 'x4Qa'
                            }
                          ]}
                          onSave={saved}
                        />
                      </li>
                    ) : undefined
                  }
                />
                <CloudEnvironmentPanelSection
                  load={load}
                  onRetry={noop}
                  onAdd={saved}
                  showLoadError={false}
                />
              </>
            ) : null
          }
          onFooterLink={noop}
        />
      </Sheet>
    </div>
  )
}

export const cloudAdmin = defineFixture({
  width: 1000,
  render: () => <CloudPanel load={secrets('admin')} desktopKey />
})

const SHARED_REASON = 'Personal accounts aren’t used in shared workspaces.'
const SHARED_ROWS: CloudAgentsPanelLoad = {
  kind: 'ready',
  rows: [
    {
      agent: 'claude',
      status: { kind: 'key', keyKind: 'team' },
      source: { value: 'key', keyKind: 'team' }
    },
    { agent: 'codex', status: { kind: 'key', keyKind: 'team' }, source: null }
  ]
}
const SHARED_NO_KEY: CloudAgentsPanelLoad = {
  kind: 'ready',
  rows: [
    { agent: 'claude', status: { kind: 'sharedUnavailable' }, source: null },
    { agent: 'codex', status: { kind: 'key', keyKind: 'team' }, source: null }
  ]
}

/** D13: a member in a shared workspace; the team key applies and the Source can't change. */
export const cloudMember = defineFixture({
  width: 1000,
  render: () => (
    <CloudPanel
      load={secrets('member')}
      agents={SHARED_ROWS}
      sourceDisabledReason={translate('agentSources.shared', SHARED_REASON)}
    />
  )
})

export const cloudSharedNoTeamKey = defineFixture({
  width: 1000,
  render: () => (
    <CloudPanel
      load={secrets('member')}
      agents={SHARED_NO_KEY}
      sourceDisabledReason={translate('agentSources.shared', SHARED_REASON)}
    />
  )
})

export const cloudAsleep = defineFixture({
  width: 1000,
  render: () => <CloudPanel availability="asleep" load={secrets('member', true)} />
})

export const cloudSignOff = defineFixture({
  width: 1000,
  render: () => (
    <CloudPanel
      load={secrets('admin')}
      agents={{
        kind: 'ready',
        rows: [
          { agent: 'claude', status: { kind: 'signsInHere', reason: 'paused' }, source: null },
          { agent: 'codex', status: { kind: 'signsInHere', reason: 'notOffered' }, source: null }
        ]
      }}
    />
  )
})

export const cloudSignedOutOfOrca = defineFixture({
  width: 1000,
  render: () => <CloudPanel agents={{ kind: 'signedOut' }} />
})

export const hostMenu = defineFixture({
  width: 320,
  render: () => (
    <div className="h-[260px] p-2">
      <DropdownMenu open modal={false}>
        <DropdownMenuTrigger>Orca Cloud</DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="w-56">
          <DropdownMenuLabel className="truncate text-[11px] font-medium text-muted-foreground">
            Orca Cloud
          </DropdownMenuLabel>
          <DropdownMenuItem>
            <Pencil className="size-3.5" />
            Rename…
          </DropdownMenuItem>
          <DropdownMenuItem>
            <RefreshCw className="size-3.5" />
            Check connection
          </DropdownMenuItem>
          <AgentHostPanelMenuItem hostId="runtime:env-cloud" />
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
})
