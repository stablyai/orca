// AgentHostPanel fixtures for hosts that keep their own login (spec §4 P-1…P-5). Re-exported from
// AgentHostPanel.fixture.tsx so the ids read agent-host-panel/AgentHostPanel:<name>.
import React from 'react'
import { defineFixture } from '../../component-fixtures/component-fixture'
import { Sheet } from '@/components/ui/sheet'
import { translate } from '@/i18n/i18n'
import type { AgentApiKeySummary } from '../../../../shared/agent-api-keys/agent-api-key-catalog'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import {
  hostCapabilities,
  type AgentHostAvailability,
  type AgentHostKind
} from './agent-host-capabilities'
import { AgentHostPanelView } from './AgentHostPanelView'
import { HostAgentsPanelSection } from './HostAgentsPanelSection'
import { HostKeysRows } from './HostPanelBody'
import type { HostAgentPanelRow } from './host-agents-panel-model'
import { RecipeEnvForwardingWarning } from './RecipeEnvForwardingWarning'

const noop = (): void => {}

const KEYS: AgentApiKeySummary[] = [
  {
    id: 'k1',
    agent: 'claude',
    envName: 'ANTHROPIC_API_KEY',
    hostScope: { kind: 'all' },
    hint: 'x4Qa',
    updatedAt: 0
  }
]

const SIGNED_IN: HostAgentPanelRow[] = [
  { agent: 'claude', state: 'signedIn', canSignOut: true },
  { agent: 'codex', state: 'signedOut', canSignOut: false }
]

export function HostFixture({
  kind,
  host,
  availability = 'available',
  rows = SIGNED_IN,
  keys = KEYS,
  failed = false,
  lastChecked = null,
  dot = null,
  codeSignIn,
  accounts
}: {
  kind: AgentHostKind
  host: string
  availability?: AgentHostAvailability
  rows?: HostAgentPanelRow[] | null
  keys?: AgentApiKeySummary[]
  failed?: boolean
  lastChecked?: string | null
  dot?: CloudDotState | null
  codeSignIn?: React.ComponentProps<typeof HostAgentsPanelSection>['codeSignIn']
  accounts?: React.ComponentProps<typeof HostAgentsPanelSection>['accounts']
}): React.JSX.Element {
  const capabilities = hostCapabilities(kind, availability, { host, date: lastChecked }, translate)
  return (
    <div className="h-[760px] bg-background">
      <Sheet open modal={false}>
        <AgentHostPanelView
          capabilities={capabilities}
          subject={host}
          dot={dot}
          agents={
            <HostAgentsPanelSection
              title={capabilities.agents.title}
              help={capabilities.agents.help}
              host={host}
              rows={rows}
              checking={false}
              failed={failed}
              lastChecked={availability === 'available' ? null : lastChecked}
              signOut={capabilities.signOut}
              actionsDisabledReason={capabilities.actionsDisabledReason}
              onSignOut={noop}
              onCheckAgain={noop}
              codeSignIn={codeSignIn}
              accounts={accounts}
            />
          }
          keys={<HostKeysRows keys={keys} />}
          environment={
            kind === 'recipe' ? (
              <RecipeEnvForwardingWarning
                summary={{
                  count: 42,
                  keyLike: ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY'],
                  other: ['HOME', 'PATH'],
                  narrowed: false
                }}
              />
            ) : null
          }
          onFooterLink={noop}
        />
      </Sheet>
    </div>
  )
}

const NO_KEYS: AgentApiKeySummary[] = []
const LAST = 'Nov 9, 2026'
const WSL_ACCOUNTS = { claude: 'work@acme.dev', codex: null }

export const local = defineFixture({
  width: 1000,
  render: () => <HostFixture kind="local" host="MacBook Pro" />
})

export const sshOrcad = defineFixture({
  width: 1000,
  render: () => <HostFixture kind="sshOrcad" host="devbox" />
})

export const wsl = defineFixture({
  width: 1000,
  render: () => (
    <HostFixture kind="wsl" host="Ubuntu-24.04" keys={NO_KEYS} accounts={WSL_ACCOUNTS} />
  )
})

export const wslStopped = defineFixture({
  width: 1000,
  render: () => (
    <HostFixture
      kind="wsl"
      host="Ubuntu-24.04"
      availability="stopped"
      keys={NO_KEYS}
      accounts={WSL_ACCOUNTS}
      lastChecked={LAST}
    />
  )
})

export const recipe = defineFixture({
  width: 1000,
  render: () => <HostFixture kind="recipe" host="gpu-box" dot="running" />
})

export const recipeSuspended = defineFixture({
  width: 1000,
  render: () => (
    <HostFixture
      kind="recipe"
      host="gpu-box"
      availability="suspended"
      lastChecked={LAST}
      dot="sleeping"
    />
  )
})

export const paired = defineFixture({
  width: 1000,
  render: () => <HostFixture kind="paired" host="mac-mini" />
})

export const pairedOffline = defineFixture({
  width: 1000,
  render: () => (
    <HostFixture kind="paired" host="mac-mini" availability="unreachable" lastChecked={LAST} />
  )
})

/** An older Orca on the host answers no sign-in status. */
export const pairedOld = defineFixture({
  width: 1000,
  render: () => (
    <HostFixture
      kind="paired"
      host="mac-mini"
      failed
      rows={[
        { agent: 'claude', state: 'unknown', canSignOut: false },
        { agent: 'codex', state: 'unknown', canSignOut: false }
      ]}
    />
  )
})
